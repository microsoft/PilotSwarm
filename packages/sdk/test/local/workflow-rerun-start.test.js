import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import { WORKFLOW_TOOL_POLICY } from "../../src/workflow/tool-policy.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { WorkflowStoreError, nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { branchScopeId } from "../../src/workflow/parallel.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "entra", subject: "owner-sub-4d", displayName: "Owner" };
const OWNER_ACTOR = { kind: "user", provider: OWNER.provider, subject: OWNER.subject, name: "Owner" };
const ADMIN_ACTOR = { kind: "user", provider: "entra", subject: "admin-sub-99", name: "Admin" };
const SYSTEM_ACTOR = { kind: "system", name: "mcp-stdio" };

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

const REV1_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-start-wf, version: "1.0.0" }
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

const REV2_YAML = REV1_YAML
    .replace('version: "1.0.0"', 'version: "1.0.1"')
    .replace('fqdn: "a.db"', 'fqdn: "b.db"');

const TOOL_SCRIPT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-tool-wf, version: "1.0.0" }
limits: { maxNodeExecutions: 20 }
initial: step1
states:
  step1:
    type: script
    source: |
      await callTool("read_facts", { key_pattern: "x" });
      await setResult("ok", {});
    transition: { next: { ok: step2 } }
  step2:
    type: script
    source: |
      await callTool("read_facts", { key_pattern: "y" });
      await setResult("ok", {});
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const APPROVAL_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-approval-wf, version: "1.0.0" }
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

const PARALLEL_INBOX_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-parallel-inbox-wf, version: "1.0.0" }
limits: { maxNodeExecutions: 30 }
initial: setup
states:
  setup:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: fan, failure: failed } }
  fan:
    type: parallel
    branches:
      lane_a:
        initial: la
        states:
          la:
            type: script
            source: 'await setResult("ok", {});'
            transition: { next: { ok: la_done, failure: la_fail } }
          la_done: { type: terminal, outcome: succeeded }
          la_fail: { type: terminal, outcome: failed }
      lane_b:
        initial: lb
        states:
          lb:
            type: script
            source: 'await setResult("ok", {});'
            transition: { next: { ok: lb_done, failure: lb_fail } }
          lb_done: { type: terminal, outcome: succeeded }
          lb_fail: { type: terminal, outcome: failed }
    transition: { next: { joined: mid, blocked: failed, failure: failed } }
  mid:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: post, failure: failed } }
  post:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const RECEIVE_CARRY_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-receive-carry-wf, version: "1.0.0" }
limits: { maxNodeExecutions: 30 }
schemas:
  Note:
    type: object
    properties:
      n: { type: integer }
contracts:
  Note@1: { schema: { $ref: "#/schemas/Note" } }
initial: first
states:
  first:
    type: messaging
    mode: receive
    contract: "Note@1"
    wait: { seconds: 60 }
    transition: { next: { received: second, elapsed: failed, failure: failed } }
  second:
    type: messaging
    mode: receive
    contract: "Note@1"
    wait: { seconds: 60 }
    transition: { next: { received: work, elapsed: failed, failure: failed } }
  work:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const THREE_STEP_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-three-step-wf, version: "1.0.0" }
limits: { maxNodeExecutions: 30 }
initial: step1
states:
  step1:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: step2 } }
  step2:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: step3 } }
  step3:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

/** Wait until a backend is blocked by `blockerPid` (pg_blocking_pids) and return the blocked backend's pid. */
async function blockedBy(pool, blockerPid, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const { rows } = await pool.query(
            "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) ORDER BY pid LIMIT 1", [blockerPid]);
        if (rows[0]) return rows[0].pid;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`no backend blocked by ${blockerPid} within ${timeoutMs} ms`);
}

function deferHost(client) {
    const store = client._catalog.workflowStore();
    return {
        catalog: client._catalog,
        store,
        duroxideClient: Object.assign(Object.create(client.duroxideClient), {
            startOrchestrationVersioned: async () => {},
        }),
        scripts: true,
    };
}

function makeToolBinding(parentSessionId, overrides = {}) {
    return {
        policy: WORKFLOW_TOOL_POLICY,
        parentSessionId,
        owner: { provider: OWNER.provider, subject: OWNER.subject },
        config: { workspace: null, workspaceDefaults: null },
        capabilities: { revision: 1, selections: [{ sourceId: "pkg:demo", sourceRef: "pkg:demo", tools: ["read_facts"], mcpServers: [] }] },
        tools: [{ name: "read_facts", schemaHash: "h-rf" }],
        sourceRevisions: { "pkg:demo": "rev-1" },
        excludedTools: [],
        boundAgentFingerprint: "fp-1",
        ...overrides,
    };
}

async function seedEndedSessionWorkflow(host, opts = {}) {
    const pool = new pg.Pool(pgPoolConfig(getEnv().store));
    const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
    const ownerSessionId = opts.ownerSessionId ?? randomUUID();
    try {
        if (!(await host.catalog.getSession(ownerSessionId))) {
            await host.catalog.createSession(ownerSessionId, {
                owner: OWNER,
                ...(opts.ownerCreationConfig ? { creationConfig: opts.ownerCreationConfig } : {}),
            });
            if (opts.ownerCapabilities && host.catalog.saveSessionCapabilities) {
                await host.catalog.saveSessionCapabilities(ownerSessionId, 0, opts.ownerCapabilities);
            }
        }
        const yaml = opts.yaml ?? REV1_YAML;
        const name = opts.name ?? (yaml.match(/name:\s*([A-Za-z0-9._-]+)/)?.[1] ?? "rerun-start-wf");
        const saved = await saveSessionWorkflowDefinition(host, {
            ownerSessionId,
            name,
            yaml,
            expected: null,
            actor: OWNER_ACTOR,
            operationId: `save-rev1-${randomUUID()}`,
        });
        const definitionId = saved.receipt.definitionId;
        if (opts.rev2Yaml) {
            await saveSessionWorkflowDefinition(host, {
                ownerSessionId,
                name,
                expected: { definitionId, revision: 1 },
                yaml: opts.rev2Yaml,
                actor: OWNER_ACTOR,
                operationId: `save-rev2-${randomUUID()}`,
            });
        }
        const started = await startSessionWorkflowDefinition(host, {
            ownerSessionId,
            parentSessionId: opts.parentSessionId ?? ownerSessionId,
            definition: { definitionId },
            revision: 1,
            inputs: opts.inputs ?? {},
            actor: OWNER_ACTOR,
            owner: OWNER,
            operationId: `src-start-${definitionId}`,
            binding: opts.binding ?? null,
        });
        const visits = opts.visits ?? [
            { nodeId: "step1", ordinal: 1, nodeType: "script", outcome: "ok", resultKind: "business", output: { v: 1 }, input: {} },
            { nodeId: "step2", ordinal: 1, nodeType: "script", arrivalRoute: "ok", outcome: "timed_out", resultKind: "runtime_error", error: { code: "timed_out", message: "slow" }, input: { v: 1 } },
        ];
        let prev = null;
        const ids = {};
        const baseMs = Date.now() - 30_000;
        for (let i = 0; i < visits.length; i += 1) {
            const v = visits[i];
            // A lane visit ({ lane: { parent: "<parallel>#<visit>", index } }) runs in its parallel visit's branch scope.
            const scopeId = v.lane ? branchScopeId(ids[v.lane.parent], v.lane.index) : "root";
            const predecessorId = v.lane ? ids[v.lane.parent] : prev;
            const id = nodeExecutionIdFor(started.runId, scopeId, v.nodeId, v.ordinal);
            const inputText = canonicalJson(v.input ?? {});
            const outputText = v.resultKind === "business" ? canonicalJson(v.output ?? null) : null;
            const errorText = v.resultKind === "runtime_error" ? canonicalJson(v.error ?? { code: v.outcome ?? "err", message: "err" }) : null;
            const enteredMs = baseMs + (v.enteredMs ?? i * 1000);
            const completedMs = v.completedMs === undefined ? enteredMs + 400 : baseMs + v.completedMs;
            await pool.query(
                `INSERT INTO ${s}.workflow_node_executions (
                    node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                    input, input_sha256, state, outcome, result_kind, output, error, winner,
                    effect_attempts, entered_at, completed_at, kv_revision, deadline_at
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'completed',$11,$12,$13,$14,$15,1,$16::timestamptz,$17::timestamptz,1,NULL)`,
                [
                    id, started.runId, scopeId, predecessorId, v.nodeId, v.ordinal, v.nodeType, v.arrivalRoute ?? null,
                    inputText, sha256Hex(inputText), v.outcome ?? "ok", v.resultKind ?? "business",
                    outputText, errorText, v.winner ?? "effect",
                    new Date(enteredMs).toISOString(), new Date(completedMs).toISOString(),
                ],
            );
            ids[`${v.nodeId}#${v.ordinal}`] = id;
            if (v.nodeType === "approval" && (v.outcome === "approved" || v.outcome === "rejected")) {
                const decidedBy = v.output?.decidedBy ?? OWNER;
                const snapText = canonicalJson({ question: "Deploy to prod?" });
                await pool.query(
                    `INSERT INTO ${s}.workflow_approvals (
                        node_execution_id, workflow_session_id, run_id,
                        owner_provider, owner_subject, snapshot, context_sha256,
                        decision, reason, decided_by, decided_at, operation_id
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11)`,
                    [
                        id, started.workflowId, started.runId,
                        OWNER.provider, OWNER.subject, snapText, sha256Hex(snapText),
                        v.outcome, v.outcome === "rejected" ? "no" : null, JSON.stringify(decidedBy), `op-app-${id}`,
                    ],
                );
            }
            if (!v.lane) prev = id;
        }
        if (!opts.leaveActive) {
            await pool.query(`UPDATE ${s}.workflow_runs SET status = 'failed', finished_at = now() WHERE run_id = $1`, [started.runId]);
        }
        return { ownerSessionId, definitionId, workflowId: started.workflowId, runId: started.runId, ids, baseMs };
    } finally {
        await pool.end();
    }
}

async function expectCode(promise, code) {
    let caught = null;
    try { await promise; } catch (err) { caught = err; }
    expect(caught, `expected ${code}`).toBeInstanceOf(WorkflowStoreError);
    expect(caught.code, caught.message).toBe(code);
    return caught;
}

describe("Task 4d: startSessionWorkflowDefinition rerunFrom, source-rev default, replay/conflict, OQ1 & OQ5", () => {
    it("starts run_again and supply re-runs, defaults to source revision (not newestValid), replays receipt-first after #2 is swept, and conflicts on supply payload change", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = deferHost(client);
            const src = await seedEndedSessionWorkflow(h, { rev2Yaml: REV2_YAML });

            // 1. Source-revision default: rev 2 exists, omitted revision MUST target rev 1 (sourceRun.revision)
            const r1 = await startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "rerun-default-rev",
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" },
            });
            expect(r1.revision).toBe(1);
            expect(r1.replayed).toBe(false);
            expect(r1.rerun?.ofWorkflowId).toBe(src.workflowId);
            expect(r1.rerun?.mode).toBe("run_again");
            expect(r1.rerun?.reused).toBe(1);

            // 1b. Continue mode on completed visit sets rerunResume.predecessorId to the MAPPED chosen execution ID
            // (not chosen.predecessorId, which is null on visit 1 and causes predecessor_mismatch on the first new step).
            const rCont = await startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "rerun-continue-step1",
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step1#1"], mode: "continue" },
            });
            expect(rCont.rerun?.mode).toBe("continue");
            expect(rCont.rerun?.reused).toBe(1);
            const rContRow = await h.store.readRun(rCont.runId);
            const rContNodes = await h.store.listNodeExecutions(rCont.runId);
            const rContMappedStep1 = rContNodes.find(n => n.nodeId === "step1");
            expect(rContMappedStep1?.reusedFromExecutionId).toBe(src.ids["step1#1"]);
            expect(rContRow?.rerunResume?.mode).toBe("continue");
            expect(rContRow?.rerunResume?.predecessorId).toBe(rContMappedStep1?.nodeExecutionId);

            // 2. Supply mode with explicit key, replay after #2 is soft-deleted, and OPERATION_CONFLICT on mutated output/note
            const supKey = `sup-key-${randomUUID()}`;
            const rSup = await startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "op-sup-1",
                key: supKey,
                rerunFrom: {
                    workflowId: src.workflowId,
                    executionId: src.ids["step2#1"],
                    mode: "supply",
                    result: { outcome: "ok", output: { fqdn: "verified.db" } },
                    note: "verified via az cli",
                },
            });
            expect(rSup.revision).toBe(1);
            expect(rSup.rerun?.mode).toBe("supply");
            expect(rSup.rerun?.supplied?.outcome).toBe("ok");

            // Soft-delete source #2; identical replay with same key MUST still succeed receipt-first!
            await h.catalog.softDeleteSession(src.workflowId);
            const rSupReplay = await startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "op-sup-2",
                key: supKey,
                rerunFrom: {
                    workflowId: src.workflowId,
                    executionId: src.ids["step2#1"],
                    mode: "supply",
                    result: { outcome: "ok", output: { fqdn: "verified.db" } },
                    note: "verified via az cli",
                },
            });
            expect(rSupReplay.replayed).toBe(true);
            expect(rSupReplay.workflowId).toBe(rSup.workflowId);

            // Mutating supply note or output under same key refuses 409 OPERATION_CONFLICT!
            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "op-sup-3",
                key: supKey,
                rerunFrom: {
                    workflowId: src.workflowId,
                    executionId: src.ids["step2#1"],
                    mode: "supply",
                    result: { outcome: "ok", output: { fqdn: "changed.db" } },
                    note: "verified via az cli",
                },
            }), "OPERATION_CONFLICT");

            // Fresh start referencing swept #2 refuses RERUN_SOURCE_GONE
            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "op-after-sweep",
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" },
            }), "RERUN_SOURCE_GONE");
        });
    });

    it("enforces OQ1 narrow owner tool-grant inheritance (409 WORKFLOW_TOOLS_UNAVAILABLE on drift/non-owner/proxied/inMemory/spawned) and OQ5 approval reuse gate (403 RERUN_APPROVAL_REUSED on viaMcp or proxied)", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = deferHost(client);
            const ownerSessionId = randomUUID();
            const caps = { revision: 1, selections: [{ sourceId: "pkg:demo", sourceRef: "pkg:demo", tools: ["read_facts"], mcpServers: [] }] };
            const src = await seedEndedSessionWorkflow(h, {
                ownerSessionId,
                yaml: TOOL_SCRIPT_YAML,
                ownerCapabilities: caps,
                binding: makeToolBinding(ownerSessionId),
            });

            // 1. Direct non-MCP owner Start with binding omitted -> inherits source binding (grant: "inherited")!
            const okInherit = await startSessionWorkflowDefinition(h, {
                ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "oq1-ok",
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" },
            });
            expect(okInherit.rerun?.grant).toBe("inherited");

            // 2. Proxied call (originatingSessionId set) -> 409 WORKFLOW_TOOLS_UNAVAILABLE
            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                originatingSessionId: "agent-sess-1",
                operationId: "oq1-proxied",
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" },
            }), "WORKFLOW_TOOLS_UNAVAILABLE");

            // 3. Non-owner admin & system actor -> 409 WORKFLOW_TOOLS_UNAVAILABLE
            for (const [label, actor] of [["admin", ADMIN_ACTOR], ["system", SYSTEM_ACTOR]]) {
                await expectCode(startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: src.definitionId },
                    inputs: {},
                    actor,
                    owner: OWNER,
                    operationId: `oq1-${label}`,
                    rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" },
                }), "WORKFLOW_TOOLS_UNAVAILABLE");
            }

            // 4. Capability selection drift on owning session -> 409 WORKFLOW_TOOLS_UNAVAILABLE
            if (h.catalog.saveSessionCapabilities) {
                await h.catalog.saveSessionCapabilities(ownerSessionId, 1, { revision: 2, selections: [] });
                await expectCode(startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: src.definitionId },
                    inputs: {},
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: "oq1-cap-drift",
                    rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" },
                }), "WORKFLOW_TOOLS_UNAVAILABLE");
                await h.catalog.saveSessionCapabilities(ownerSessionId, 2, { ...caps, revision: 3 });
            }

            // 5. inMemory source binding -> 409 WORKFLOW_TOOLS_UNAVAILABLE
            const srcMem = await seedEndedSessionWorkflow(h, {
                ownerSessionId,
                name: "rerun-tool-inmem",
                yaml: TOOL_SCRIPT_YAML.replace("rerun-tool-wf", "rerun-tool-inmem"),
                binding: makeToolBinding(ownerSessionId, { inMemory: { ancestorSessionId: ownerSessionId, tools: [] } }),
            });
            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId,
                definition: { definitionId: srcMem.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "oq1-inmem",
                rerunFrom: { workflowId: srcMem.workflowId, executionId: srcMem.ids["step2#1"], mode: "run_again" },
            }), "WORKFLOW_TOOLS_UNAVAILABLE");

            // 5b. Spawned-child source binding (parentSessionId !== ownerSessionId) -> 409 WORKFLOW_TOOLS_UNAVAILABLE
            const srcSpawned = await seedEndedSessionWorkflow(h, {
                ownerSessionId,
                name: "rerun-tool-spawned",
                yaml: TOOL_SCRIPT_YAML.replace("rerun-tool-wf", "rerun-tool-spawned"),
                binding: makeToolBinding("other-parent-wf-id"),
            });
            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId,
                definition: { definitionId: srcSpawned.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "oq1-spawned",
                rerunFrom: { workflowId: srcSpawned.workflowId, executionId: srcSpawned.ids["step2#1"], mode: "run_again" },
            }), "WORKFLOW_TOOLS_UNAVAILABLE");

            // 5c. toolCeiling drift & excludedTools drift on owning session -> 409 WORKFLOW_TOOLS_UNAVAILABLE
            const driftOwnerId = randomUUID();
            const srcDrift = await seedEndedSessionWorkflow(h, {
                ownerSessionId: driftOwnerId,
                yaml: TOOL_SCRIPT_YAML,
                ownerCapabilities: caps,
                ownerCreationConfig: { toolCeiling: ["other_tool"], excludedTools: [] },
                binding: makeToolBinding(driftOwnerId),
            });
            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId: driftOwnerId,
                definition: { definitionId: srcDrift.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "oq1-ceiling-drift",
                rerunFrom: { workflowId: srcDrift.workflowId, executionId: srcDrift.ids["step2#1"], mode: "run_again" },
            }), "WORKFLOW_TOOLS_UNAVAILABLE");

            const exclOwnerId = randomUUID();
            const srcExcl = await seedEndedSessionWorkflow(h, {
                ownerSessionId: exclOwnerId,
                yaml: TOOL_SCRIPT_YAML,
                ownerCapabilities: caps,
                ownerCreationConfig: { excludedTools: ["read_facts"] },
                binding: makeToolBinding(exclOwnerId),
            });
            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId: exclOwnerId,
                definition: { definitionId: srcExcl.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "oq1-excl-drift",
                rerunFrom: { workflowId: srcExcl.workflowId, executionId: srcExcl.ids["step2#1"], mode: "run_again" },
            }), "WORKFLOW_TOOLS_UNAVAILABLE");

            // 6. OQ5 / M3: Answered approval reused -> allowed for direct non-MCP owner, refused 403 for viaMcp:true and originatingSessionId!
            const srcApp = await seedEndedSessionWorkflow(h, {
                yaml: APPROVAL_YAML,
                visits: [
                    { nodeId: "gate", ordinal: 1, nodeType: "approval", outcome: "approved", resultKind: "business", output: { decision: "approved", decidedBy: OWNER, decidedAt: "2026-11-27T10:00:00Z" }, winner: "approval_owner" },
                    { nodeId: "step2", ordinal: 1, nodeType: "script", arrivalRoute: "approved", outcome: "execution_failed", resultKind: "runtime_error" },
                ],
            });
            // viaMcp: true -> 403 RERUN_APPROVAL_REUSED (OQ5)
            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId: srcApp.ownerSessionId,
                definition: { definitionId: srcApp.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                viaMcp: true,
                operationId: "oq5-mcp-app",
                rerunFrom: { workflowId: srcApp.workflowId, executionId: srcApp.ids["step2#1"], mode: "run_again" },
            }), "RERUN_APPROVAL_REUSED");

            // originatingSessionId set -> 403 RERUN_APPROVAL_REUSED (M3)
            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId: srcApp.ownerSessionId,
                definition: { definitionId: srcApp.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                originatingSessionId: "agent-proxied-1",
                operationId: "oq5-proxied-app",
                rerunFrom: { workflowId: srcApp.workflowId, executionId: srcApp.ids["step2#1"], mode: "run_again" },
            }), "RERUN_APPROVAL_REUSED");

            // Direct non-MCP non-proxied owner -> allowed!
            const okApp = await startSessionWorkflowDefinition(h, {
                ownerSessionId: srcApp.ownerSessionId,
                definition: { definitionId: srcApp.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "oq5-owner-ok",
                rerunFrom: { workflowId: srcApp.workflowId, executionId: srcApp.ids["step2#1"], mode: "run_again" },
            });
            expect(okApp.workflowId).toBeTruthy();
        });
    });

    it("maps swept bare claim shell to WORKFLOW_DELETED (R2-M1/R3-S1) and refuses bad arguments (400) vs incompatible revision (422)", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = deferHost(client);
            const src = await seedEndedSessionWorkflow(h);

            // Argument refusals -> 400 RERUN_ARGUMENT_REFUSED
            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: { disallowed: 1 },
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "bad-arg-inputs",
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" },
            }), "RERUN_ARGUMENT_REFUSED");

            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "bad-arg-note",
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again", note: "not supply" },
            }), "RERUN_ARGUMENT_REFUSED");

            // Simulate a bare claim shell swept before admission -> same key retry MUST throw WORKFLOW_DELETED (HTTP 404)!
            const sweptKey = `swept-key-${randomUUID()}`;
            // Claim & immediately soft-delete the deterministic workflowSessionId (as Sweeper does after grace)
            const firstStart = await startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "op-sweep-probe",
                key: sweptKey,
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" },
            });
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            try {
                // Simulate bare claim shell that was swept (no definition, no run, soft-deleted session)
                await pool.query(`DELETE FROM ${s}.workflow_operations WHERE workflow_session_id = $1`, [firstStart.workflowId]);
                await pool.query(`DELETE FROM ${s}.workflow_node_executions WHERE run_id = $1`, [firstStart.runId]);
                await pool.query(`DELETE FROM ${s}.workflow_kv_revisions WHERE run_id = $1`, [firstStart.runId]);
                await pool.query(`DELETE FROM ${s}.workflow_runs WHERE workflow_session_id = $1`, [firstStart.workflowId]);
                await pool.query(`DELETE FROM ${s}.workflow_revisions WHERE workflow_session_id = $1`, [firstStart.workflowId]);
                await pool.query(`DELETE FROM ${s}.workflow_definitions WHERE workflow_session_id = $1`, [firstStart.workflowId]);
                await h.catalog.softDeleteSession(firstStart.workflowId);
            } finally {
                await pool.end();
            }
            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "op-sweep-retry",
                key: sweptKey,
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" },
            }), "WORKFLOW_DELETED");

            // Claim-crash recovery (rerunPin resume) + S5 post-claim refusal shell cleanup + supply:never refusal
            const crashKey = `crash-key-${randomUUID()}`;
            let failOnce = true;
            const crashHost = {
                ...h,
                store: Object.assign(Object.create(h.store), {
                    createDefinition: async (arg) => {
                        if (failOnce) {
                            failOnce = false;
                            throw new Error("simulated crash after claim");
                        }
                        return h.store.createDefinition(arg);
                    },
                }),
            };
            await expect(startSessionWorkflowDefinition(crashHost, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "op-crash-1",
                key: crashKey,
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" },
            })).rejects.toThrow("simulated crash after claim");

            // Resume with same key completes cleanly using pinned rerunPin!
            const resumed = await startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "op-crash-2",
                key: crashKey,
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" },
            });
            expect(resumed.replayed).toBe(false);
            expect(resumed.rerun?.mode).toBe("run_again");

            // S5 post-claim refusal cleanup: if createDefinition refuses with RERUN_SOURCE_GONE after claim, claim shell is soft-deleted!
            let claimedId = null;
            const s5Host = {
                ...h,
                store: Object.assign(Object.create(h.store), {
                    createDefinition: async (arg) => {
                        claimedId = arg.workflowSessionId;
                        throw new WorkflowStoreError("RERUN_SOURCE_GONE", "source deleted under lock");
                    },
                }),
            };
            await expectCode(startSessionWorkflowDefinition(s5Host, {
                ownerSessionId: src.ownerSessionId,
                definition: { definitionId: src.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "op-s5-cleanup",
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" },
            }), "RERUN_SOURCE_GONE");
            expect(claimedId).toBeTruthy();
            expect(await h.catalog.getSession(claimedId)).toBeNull();

            // supply: never -> 422 RERUN_SUPPLY_NOT_ALLOWED
            const neverYaml = REV1_YAML.replace("rerun-start-wf", "rerun-never-wf").replace("outcomes: [ok]", "outcomes: [ok]\n    supply: never");
            const srcNever = await seedEndedSessionWorkflow(h, { yaml: neverYaml });
            await expectCode(startSessionWorkflowDefinition(h, {
                ownerSessionId: srcNever.ownerSessionId,
                definition: { definitionId: srcNever.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: "op-supply-never",
                rerunFrom: {
                    workflowId: srcNever.workflowId,
                    executionId: srcNever.ids["step2#1"],
                    mode: "supply",
                    result: { outcome: "ok", output: { fqdn: "x.db" } },
                    note: "tried to bypass supply: never",
                },
            }), "RERUN_SUPPLY_NOT_ALLOWED");
        });
    });

    it("carries waiting inbox messages up to the Design §5.4 cut (P-1: supply while V ran, run_again after a reused parallel, continue on the last top-level visit) and maps a visit-2 continue predecessor to mapped(V) (M-1)", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = deferHost(client);
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            const seedNote = async (src, n, acceptedMs) => {
                const opId = `seed-note-${n}-${randomUUID()}`;
                await pool.query(
                    `INSERT INTO ${s}.workflow_inbox (
                        message_id, workflow_session_id, run_id, sender_session_id, operation_id, request_sha256,
                        contract, correlation, payload, accepted_at, expires_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,'Note@1','null',$7,$8::timestamptz,$9::timestamptz)`,
                    [
                        `msg-${randomUUID()}`, src.workflowId, src.runId, src.ownerSessionId, opId, sha256Hex(opId),
                        canonicalJson({ n }), new Date(acceptedMs).toISOString(), new Date(acceptedMs + 3_600_000).toISOString(),
                    ],
                );
            };
            const carriedNotes = async (runId) => (await pool.query(
                `SELECT payload FROM ${s}.workflow_inbox WHERE run_id = $1 AND contract = 'Note@1' ORDER BY seq`,
                [runId],
            )).rows.map(r => JSON.parse(r.payload).n);
            try {
                // (a) supply on the last top-level visit V (step2, ran 1.0 s..1.4 s): cutAt = sourceRun.finishedAt, so a
                // message accepted WHILE V ran in #2 is carried; one accepted after #2 finished is not.
                const srcA = await seedEndedSessionWorkflow(h);
                const runA = await h.store.readRun(srcA.runId);
                await seedNote(srcA, 1, srcA.baseMs + 200);
                await seedNote(srcA, 2, srcA.baseMs + 1_200);
                await seedNote(srcA, 3, runA.finishedAt.getTime() + 5_000);
                const rA = await startSessionWorkflowDefinition(h, {
                    ownerSessionId: srcA.ownerSessionId,
                    definition: { definitionId: srcA.definitionId },
                    inputs: {},
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: "p1-supply-during-v",
                    rerunFrom: {
                        workflowId: srcA.workflowId,
                        executionId: srcA.ids["step2#1"],
                        mode: "supply",
                        result: { outcome: "ok", output: { fqdn: "p1.db" } },
                        note: "P-1 supply carry",
                    },
                });
                expect(rA.rerun?.mode).toBe("supply");
                expect(await carriedNotes(rA.runId)).toEqual([1, 2]);

                // (b) run_again from `post` after a reused parallel `fan` whose lanes finished at 1.45 s / 1.5 s:
                // cutAt = post.enteredAt (6.0 s), so a message accepted while `mid` ran (3.0 s) is carried; one
                // accepted after `post` was entered (6.2 s) is not.
                const srcB = await seedEndedSessionWorkflow(h, {
                    yaml: PARALLEL_INBOX_YAML,
                    visits: [
                        { nodeId: "setup", ordinal: 1, nodeType: "script", outcome: "ok", resultKind: "business", output: {}, enteredMs: 0, completedMs: 400 },
                        { nodeId: "fan", ordinal: 1, nodeType: "parallel", arrivalRoute: "ok", outcome: "joined", resultKind: "business", output: [{}, {}], winner: "controller", enteredMs: 1_000, completedMs: 1_600 },
                        { lane: { parent: "fan#1", index: 0 }, nodeId: "la", ordinal: 1, nodeType: "script", arrivalRoute: "@branch", outcome: "ok", resultKind: "business", output: {}, enteredMs: 1_100, completedMs: 1_500 },
                        { lane: { parent: "fan#1", index: 1 }, nodeId: "lb", ordinal: 1, nodeType: "script", arrivalRoute: "@branch", outcome: "ok", resultKind: "business", output: {}, enteredMs: 1_100, completedMs: 1_450 },
                        { nodeId: "mid", ordinal: 1, nodeType: "script", arrivalRoute: "joined", outcome: "ok", resultKind: "business", output: {}, enteredMs: 2_000, completedMs: 5_000 },
                        { nodeId: "post", ordinal: 1, nodeType: "script", arrivalRoute: "ok", outcome: "execution_failed", resultKind: "runtime_error", enteredMs: 6_000, completedMs: 6_400 },
                    ],
                });
                await seedNote(srcB, 1, srcB.baseMs + 1_300);
                await seedNote(srcB, 2, srcB.baseMs + 3_000);
                await seedNote(srcB, 3, srcB.baseMs + 6_200);
                // D-M1: accepted after the last reused root visit (mid) completed, before post was entered: still carried.
                await seedNote(srcB, 4, srcB.baseMs + 5_500);
                const rB = await startSessionWorkflowDefinition(h, {
                    ownerSessionId: srcB.ownerSessionId,
                    definition: { definitionId: srcB.definitionId },
                    inputs: {},
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: "p1-after-reused-parallel",
                    rerunFrom: { workflowId: srcB.workflowId, executionId: srcB.ids["post#1"], mode: "run_again" },
                });
                expect(rB.rerun?.mode).toBe("run_again");
                expect(rB.rerun?.reused).toBe(5);
                expect(await carriedNotes(rB.runId)).toEqual([1, 2, 4]);

                // (c) continue from the last top-level visit V (step2, visit 2 of the root chain, completed at 1.4 s):
                // cutAt = sourceRun.finishedAt, so a message accepted after V completed (2.0 s) is carried.
                const srcC = await seedEndedSessionWorkflow(h, {
                    visits: [
                        { nodeId: "step1", ordinal: 1, nodeType: "script", outcome: "ok", resultKind: "business", output: { v: 1 }, input: {} },
                        { nodeId: "step2", ordinal: 1, nodeType: "script", arrivalRoute: "ok", outcome: "ok", resultKind: "business", output: { fqdn: "a.db" }, input: { v: 1 } },
                    ],
                });
                await seedNote(srcC, 1, srcC.baseMs + 2_000);
                const rC = await startSessionWorkflowDefinition(h, {
                    ownerSessionId: srcC.ownerSessionId,
                    definition: { definitionId: srcC.definitionId },
                    inputs: {},
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: "p1-continue-last-visit",
                    rerunFrom: { workflowId: srcC.workflowId, executionId: srcC.ids["step2#1"], mode: "continue" },
                });
                expect(rC.rerun?.mode).toBe("continue");
                expect(rC.rerun?.reused).toBe(2);
                expect(await carriedNotes(rC.runId)).toEqual([1]);

                // M-1: on a visit >= 2 the first new visit enters after mapped(V), never after mapped(V.predecessor).
                const rCRow = await h.store.readRun(rC.runId);
                const rCNodes = await h.store.listNodeExecutions(rC.runId);
                const mappedStep1 = rCNodes.find(n => n.nodeId === "step1");
                const mappedStep2 = rCNodes.find(n => n.nodeId === "step2");
                expect(mappedStep2?.reusedFromExecutionId).toBe(srcC.ids["step2#1"]);
                expect(rCRow?.rerunResume?.predecessorId).toBe(mappedStep2?.nodeExecutionId);
                expect(rCRow?.rerunResume?.predecessorId).not.toBe(mappedStep1?.nodeExecutionId);
            } finally {
                await pool.end();
            }
        });
    });

    it("cuts the carried inbox at the exact microsecond (D-I1), carries messages consumed only by dropped visits (D-I2), and cuts continue at the first dropped root visit (D-M1)", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = deferHost(client);
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            // A Note@1 message of source `src`: `accepted` and `expires` are SQL timestamptz expressions ($5 is the source run id).
            const seedNoteAt = async (src, n, accepted, expires, consumedBy = null) => {
                const opId = `seed-note-${n}-${randomUUID()}`;
                await pool.query(
                    `INSERT INTO ${s}.workflow_inbox (
                        message_id, workflow_session_id, run_id, sender_session_id, operation_id, request_sha256,
                        contract, correlation, payload, accepted_at, expires_at, consumed_by, consumed_at
                     ) VALUES ($1,$2,$5,$3,$4,$6,'Note@1','null',$7,${accepted},${expires},$8::text,
                               CASE WHEN $8::text IS NULL THEN NULL ELSE ${accepted} END)`,
                    [`msg-${randomUUID()}`, src.workflowId, src.ownerSessionId, opId, src.runId, sha256Hex(opId), canonicalJson({ n }), consumedBy],
                );
            };
            const carriedNotes = async (runId) => (await pool.query(
                `SELECT payload FROM ${s}.workflow_inbox WHERE run_id = $1 AND contract = 'Note@1' ORDER BY seq`,
                [runId],
            )).rows.map(r => JSON.parse(r.payload).n);
            const start = (src, operationId, rerunFrom) => startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId, definition: { definitionId: src.definitionId }, inputs: {}, actor: OWNER_ACTOR, owner: OWNER,
                operationId, rerunFrom: { workflowId: src.workflowId, ...rerunFrom },
            });
            try {
                // D-I1: step2 (the cut of a run_again of step2) entered at a time with 900 microseconds past the millisecond.
                // Note 1, accepted 400 us before the cut and unexpired, waits at the cut; note 2 expired 500 us before the cut;
                // note 3 was accepted 100 us after the cut. A cut truncated to the millisecond would carry note 2 and drop note 1.
                const srcP = await seedEndedSessionWorkflow(h);
                const { rows: [cutRow] } = await pool.query(
                    `UPDATE ${s}.workflow_node_executions SET entered_at = date_trunc('milliseconds', entered_at) + interval '900 microseconds'
                      WHERE node_execution_id = $1 RETURNING to_char(entered_at AT TIME ZONE 'UTC', 'US') AS us`,
                    [srcP.ids["step2#1"]],
                );
                expect(cutRow.us.endsWith("900")).toBe(true);
                const cutSql = `(SELECT entered_at FROM ${s}.workflow_node_executions WHERE run_id = $5 AND node_id = 'step2')`;
                await seedNoteAt(srcP, 1, `${cutSql} - interval '400 microseconds'`, `${cutSql} + interval '1 hour'`);
                await seedNoteAt(srcP, 2, `${cutSql} - interval '10 seconds'`, `${cutSql} - interval '500 microseconds'`);
                await seedNoteAt(srcP, 3, `${cutSql} + interval '100 microseconds'`, `${cutSql} + interval '1 hour'`);
                // Exact-cut boundaries (Inv_InboxCarryExact: accepted_at <= cut < expires_at): note 4 accepted at the cut
                // microsecond itself is carried, note 5 one microsecond later is not; note 6 expiring at the cut microsecond
                // is not carried, note 7 expiring one microsecond later is.
                await seedNoteAt(srcP, 4, cutSql, `${cutSql} + interval '1 hour'`);
                await seedNoteAt(srcP, 5, `${cutSql} + interval '1 microsecond'`, `${cutSql} + interval '1 hour'`);
                await seedNoteAt(srcP, 6, `${cutSql} - interval '10 seconds'`, cutSql);
                await seedNoteAt(srcP, 7, `${cutSql} - interval '10 seconds'`, `${cutSql} + interval '1 microsecond'`);
                const { rows: edges } = await pool.query(
                    `SELECT (payload::jsonb->>'n')::int AS n, to_char(accepted_at AT TIME ZONE 'UTC', 'US') AS acc,
                            to_char(expires_at AT TIME ZONE 'UTC', 'US') AS exp
                       FROM ${s}.workflow_inbox WHERE run_id = $1 AND contract = 'Note@1' ORDER BY seq`,
                    [srcP.runId],
                );
                const edgeOf = n => edges.find(r => r.n === n);
                expect([edgeOf(4).acc, edgeOf(5).acc, edgeOf(6).exp, edgeOf(7).exp].map(us => us.slice(-3))).toEqual(["900", "901", "900", "901"]);
                const rP = await start(srcP, "d-i1-microsecond-cut", { executionId: srcP.ids["step2#1"], mode: "run_again" });
                expect(await carriedNotes(rP.runId)).toEqual([1, 4, 7]);
                expect(await h.store.summarizeRerunCarriedInbox(srcP.runId, { enteredAtOf: srcP.ids["step2#1"] }, [], [srcP.ids["step1#1"]]))
                    .toEqual({ count: 3, contracts: ["Note@1"] });

                // D-I2 + D-M1: first (receive, kept) consumed note 1; second (receive) consumed note 2; note 3 waited unconsumed.
                // Notes 4 and 5 were accepted before and after second's entry, both before the source run finished.
                const srcR = await seedEndedSessionWorkflow(h, {
                    yaml: RECEIVE_CARRY_YAML,
                    visits: [
                        { nodeId: "first", ordinal: 1, nodeType: "messaging", outcome: "received", resultKind: "business", output: { n: 1 }, enteredMs: 0, completedMs: 400 },
                        { nodeId: "second", ordinal: 1, nodeType: "messaging", arrivalRoute: "received", outcome: "received", resultKind: "business", output: { n: 2 }, enteredMs: 1_000, completedMs: 1_400 },
                        { nodeId: "work", ordinal: 1, nodeType: "script", arrivalRoute: "received", outcome: "execution_failed", resultKind: "runtime_error", enteredMs: 2_000, completedMs: 2_400 },
                    ],
                });
                const at = ms => `'${new Date(srcR.baseMs + ms).toISOString()}'::timestamptz`;
                await seedNoteAt(srcR, 1, at(100), at(3_600_000), srcR.ids["first#1"]);
                await seedNoteAt(srcR, 2, at(200), at(3_600_000), srcR.ids["second#1"]);
                await seedNoteAt(srcR, 3, at(300), at(3_600_000));
                await seedNoteAt(srcR, 4, at(500), at(3_600_000));
                await seedNoteAt(srcR, 5, at(1_500), at(3_600_000));
                const runR = await h.store.readRun(srcR.runId);
                expect(runR.finishedAt.getTime()).toBeGreaterThan(srcR.baseMs + 2_400);

                // run_again of second keeps only first: note 2 (consumed by the dropped second) waits again for second's re-run;
                // note 1 stays consumed by the kept first. The carried-message preview counts the same messages.
                const rAgain = await start(srcR, "d-i2-run-again-second", { executionId: srcR.ids["second#1"], mode: "run_again" });
                expect(await carriedNotes(rAgain.runId)).toEqual([2, 3, 4]);
                expect(await h.store.summarizeRerunCarriedInbox(srcR.runId, { enteredAtOf: srcR.ids["second#1"] }, [], [srcR.ids["first#1"]]))
                    .toEqual({ count: 3, contracts: ["Note@1"] });

                // continue from first cuts at second's entry (the first dropped root visit), not at the source run's end: note 5,
                // accepted after second was entered but before the run finished, is not carried.
                const rContinue = await start(srcR, "d-m1-continue-first", { executionId: srcR.ids["first#1"], mode: "continue" });
                expect(rContinue.rerun?.mode).toBe("continue");
                expect(await carriedNotes(rContinue.runId)).toEqual([2, 3, 4]);
                expect(await h.store.summarizeRerunCarriedInbox(srcR.runId, { sourceRunEnd: true }, [], [srcR.ids["first#1"]]))
                    .toEqual({ count: 4, contracts: ["Note@1"] });
            } finally {
                await pool.end();
            }
        });
    });

    it("carries a message that waited at a cut inside a re-run's copied prefix, with its TTL restarted again (RR-1: #1 -> #2 -> #3)", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = deferHost(client);
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            const ttlMs = 3_600_000;
            const seedNote = async (src, n, acceptedMs) => {
                const opId = `seed-note-${n}-${randomUUID()}`;
                await pool.query(
                    `INSERT INTO ${s}.workflow_inbox (
                        message_id, workflow_session_id, run_id, sender_session_id, operation_id, request_sha256,
                        contract, correlation, payload, accepted_at, expires_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,'Note@1','null',$7,$8::timestamptz,$9::timestamptz)`,
                    [
                        `msg-${randomUUID()}`, src.workflowId, src.runId, src.ownerSessionId, opId, sha256Hex(opId),
                        canonicalJson({ n }), new Date(acceptedMs).toISOString(), new Date(acceptedMs + ttlMs).toISOString(),
                    ],
                );
            };
            const carried = async (runId) => (await pool.query(
                `SELECT (payload::jsonb->>'n')::int AS n, EXTRACT(EPOCH FROM (expires_at - now()))::float8 AS ttl_left_s
                   FROM ${s}.workflow_inbox WHERE run_id = $1 AND contract = 'Note@1' ORDER BY seq`,
                [runId],
            )).rows;
            const start = (src, operationId, rerunFrom) => startSessionWorkflowDefinition(h, {
                ownerSessionId: src.ownerSessionId, definition: { definitionId: src.definitionId }, inputs: {}, actor: OWNER_ACTOR, owner: OWNER,
                operationId, rerunFrom: { workflowId: src.workflowId, ...rerunFrom },
            });
            try {
                // #1: step1 (0 ms), step2 (1,000 ms), step3 failed (2,000 ms). Note 1 was accepted while step1 ran (500 ms), note 2
                // while step2 ran (1,500 ms); nobody read either.
                const src1 = await seedEndedSessionWorkflow(h, {
                    yaml: THREE_STEP_YAML,
                    visits: [
                        { nodeId: "step1", ordinal: 1, nodeType: "script", outcome: "ok", resultKind: "business", output: {}, enteredMs: 0, completedMs: 400 },
                        { nodeId: "step2", ordinal: 1, nodeType: "script", arrivalRoute: "ok", outcome: "ok", resultKind: "business", output: {}, enteredMs: 1_000, completedMs: 1_400 },
                        { nodeId: "step3", ordinal: 1, nodeType: "script", arrivalRoute: "ok", outcome: "execution_failed", resultKind: "runtime_error", enteredMs: 2_000, completedMs: 2_400 },
                    ],
                });
                await seedNote(src1, 1, src1.baseMs + 500);
                await seedNote(src1, 2, src1.baseMs + 1_500);

                // #2 = run_again of #1 from step3: it copies step1 and step2 (with their #1 entry times) and carries both notes.
                const r2 = await start(src1, "rr1-gen2", { executionId: src1.ids["step3#1"], mode: "run_again" });
                expect((await carried(r2.runId)).map(r => r.n)).toEqual([1, 2]);
                await pool.query(`UPDATE ${s}.workflow_runs SET status = 'failed', finished_at = now() WHERE run_id = $1`, [r2.runId]);
                const r2Nodes = await h.store.listNodeExecutions(r2.runId);
                const copiedStep1 = r2Nodes.find(n => n.nodeId === "step1");
                const copiedStep2 = r2Nodes.find(n => n.nodeId === "step2");
                expect(copiedStep1?.reusedFromExecutionId).toBe(src1.ids["step1#1"]);
                expect(copiedStep2?.reusedFromExecutionId).toBe(src1.ids["step2#1"]);
                const src2 = { ...src1, workflowId: r2.workflowId, runId: r2.runId };

                // #3 = run_again of #2 from its copied step2: the cut is that visit's entry (1,000 ms in #1's time). Note 1 waited
                // there, in #1 and in #2's copied history; note 2 was accepted after it. The copy restarts note 1's TTL again.
                const r3 = await start(src2, "rr1-gen3-run-again", { executionId: copiedStep2.nodeExecutionId, mode: "run_again" });
                const r3Notes = await carried(r3.runId);
                expect(r3Notes.map(r => r.n)).toEqual([1]);
                expect(r3Notes[0].ttl_left_s).toBeGreaterThan(ttlMs / 1000 - 60);
                expect(r3Notes[0].ttl_left_s).toBeLessThanOrEqual(ttlMs / 1000);
                expect(await h.store.summarizeRerunCarriedInbox(r2.runId, { enteredAtOf: copiedStep2.nodeExecutionId }, [], [copiedStep1.nodeExecutionId]))
                    .toEqual({ count: 1, contracts: ["Note@1"] });

                // continue from #2's copied step1 cuts at the first dropped root visit (the copied step2): the same carry.
                const r3c = await start(src2, "rr1-gen3-continue", { executionId: copiedStep1.nodeExecutionId, mode: "continue" });
                expect((await carried(r3c.runId)).map(r => r.n)).toEqual([1]);
            } finally {
                await pool.end();
            }
        });
    });

    it("ends a run no earlier than an input it accepted while the end waited for the session lock, so the run-end cut carries it (MSG-1)", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = deferHost(client);
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const holder = new pg.Client(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            await holder.connect();
            try {
                // An active run (step1 ok, step2 timed out) that a re-run will continue from its last visit, cutting at its end.
                const src = await seedEndedSessionWorkflow(h, { leaveActive: true });
                // A transaction holds the run row. Input acceptance A takes the session locks, then waits for the run row. The
                // run's end E begins (its now() is read here) and waits for the session lock A holds. A then reads the store's
                // clock after its locks and commits; E ends the run after it.
                await holder.query("BEGIN");
                await holder.query(`SELECT 1 FROM ${s}.workflow_runs WHERE run_id = $1 FOR UPDATE`, [src.runId]);
                const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
                const accept = h.store.acceptInput({
                    workflowSessionId: src.workflowId, runId: src.runId, messageId: `msg-${randomUUID()}`, senderSessionId: src.ownerSessionId,
                    operationId: "msg1-raced-note", requestSha256: sha256Hex("msg1-raced-note"), contract: "Note@1", correlationText: "null",
                    payloadText: canonicalJson({ n: 1 }), ttlSeconds: 3_600,
                    limits: { maxUnconsumed: 100, maxUnconsumedPerSender: 20, maxPerSenderPerWindow: 60, windowSeconds: 600 },
                });
                const acceptPid = await blockedBy(pool, holderPid);
                const finish = h.store.finishRun({
                    runId: src.runId, status: "failed", terminalNodeId: null, terminalOutcome: null, outputText: null,
                    errorText: canonicalJson({ code: "execution_failed", message: "step2 failed" }),
                    endPending: { winner: "controller", message: "The run ended." },
                });
                await blockedBy(pool, acceptPid);
                await holder.query("SELECT pg_sleep(0.05)");
                await holder.query("COMMIT");
                const [accepted, ended] = await Promise.all([accept, finish]);
                expect(accepted.replayed).toBe(false);
                expect(ended.ended).toBe(true);

                // continue from the last visit cuts at the source run's end: the input the run accepted is carried.
                const rerun = await startSessionWorkflowDefinition(h, {
                    ownerSessionId: src.ownerSessionId, definition: { definitionId: src.definitionId }, inputs: {}, actor: OWNER_ACTOR, owner: OWNER,
                    operationId: "msg1-continue-last", rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "continue" },
                });
                const { rows: notes } = await pool.query(
                    `SELECT payload FROM ${s}.workflow_inbox WHERE run_id = $1 AND contract = 'Note@1' ORDER BY seq`, [rerun.runId]);
                expect(notes.map(r => JSON.parse(r.payload).n)).toEqual([1]);
                expect(await h.store.summarizeRerunCarriedInbox(src.runId, { sourceRunEnd: true }, [], [src.ids["step1#1"], src.ids["step2#1"]]))
                    .toEqual({ count: 1, contracts: ["Note@1"] });
                const { rows: [times] } = await pool.query(
                    `SELECT i.accepted_at <= r.finished_at AS accepted_before_end
                       FROM ${s}.workflow_inbox i JOIN ${s}.workflow_runs r ON r.run_id = i.run_id
                      WHERE i.run_id = $1 AND i.operation_id = 'msg1-raced-note'`,
                    [src.runId],
                );
                expect(times.accepted_before_end).toBe(true);
            } finally {
                await holder.query("ROLLBACK").catch(() => {});
                await holder.end();
                await pool.end();
            }
        });
    });

    it("removes its own unadmitted claim shell after any admission refusal, fresh or resumed, and never a concurrent delivery's admitted Workflow (RR-4)", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = deferHost(client);
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            const shellRow = async (id) => (await pool.query(`SELECT deleted_at FROM ${s}.sessions WHERE session_id = $1`, [id])).rows[0] ?? null;
            // A host whose admission runs `before` (between the claim and createDefinition), then the real admission.
            const hookHost = (before) => ({ ...h, store: Object.assign(Object.create(h.store), {
                createDefinition: async (arg) => { await before(arg); return h.store.createDefinition(arg); },
            }) });
            const rerunOf = (src, extra) => ({
                ownerSessionId: src.ownerSessionId, definition: { definitionId: src.definitionId }, inputs: {}, actor: OWNER_ACTOR, owner: OWNER,
                rerunFrom: { workflowId: src.workflowId, executionId: src.ids["step2#1"], mode: "run_again" }, ...extra,
            });
            try {
                // (a) Fresh claim; the owner session completes (not deleted) before the admission: SESSION_NOT_LIVE.
                const srcA = await seedEndedSessionWorkflow(h);
                let shellA = null;
                await expectCode(startSessionWorkflowDefinition(hookHost(async (arg) => {
                    shellA = arg.workflowSessionId;
                    await pool.query(`UPDATE ${s}.sessions SET state = 'completed' WHERE session_id = $1`, [srcA.ownerSessionId]);
                }), rerunOf(srcA, { operationId: "rr4-owner-completed" })), "SESSION_NOT_LIVE");
                expect(shellA).toBeTruthy();
                expect((await shellRow(shellA))?.deleted_at ?? null).not.toBeNull();

                // (b) Fresh claim; the session's definition is deleted before the admission: DEFINITION_DELETED.
                const srcB = await seedEndedSessionWorkflow(h);
                let shellB = null;
                await expectCode(startSessionWorkflowDefinition(hookHost(async (arg) => {
                    shellB = arg.workflowSessionId;
                    await pool.query(`UPDATE ${s}.session_workflow_definitions SET deleted_at = now() WHERE definition_id = $1`, [srcB.definitionId]);
                }), rerunOf(srcB, { operationId: "rr4-definition-deleted" })), "DEFINITION_DELETED");
                expect((await shellRow(shellB))?.deleted_at ?? null).not.toBeNull();

                // (c) A claim left by a crash (kept for its retry); the retry resumes it and is refused in its admission.
                const srcC = await seedEndedSessionWorkflow(h);
                const keyC = `rr4-resumed-${randomUUID()}`;
                let shellC = null;
                const crashHost = { ...h, store: Object.assign(Object.create(h.store), {
                    createDefinition: async (arg) => { shellC = arg.workflowSessionId; throw new Error("simulated crash after claim"); },
                }) };
                await expect(startSessionWorkflowDefinition(crashHost, rerunOf(srcC, { operationId: "rr4-resumed-1", key: keyC })))
                    .rejects.toThrow("simulated crash after claim");
                expect((await shellRow(shellC))?.deleted_at).toBeNull();
                await expectCode(startSessionWorkflowDefinition(hookHost(async () => {
                    await pool.query(`UPDATE ${s}.sessions SET state = 'failed' WHERE session_id = $1`, [srcC.ownerSessionId]);
                }), rerunOf(srcC, { operationId: "rr4-resumed-2", key: keyC })), "SESSION_NOT_LIVE");
                expect((await shellRow(shellC))?.deleted_at ?? null).not.toBeNull();

                // (d) Two deliveries of one keyed Start: A claims and is refused (RERUN_APPROVAL_REUSED, for another actor) only
                // after B, which resumed A's claim, committed its admission. A's cleanup must leave B's admitted Workflow.
                const srcD = await seedEndedSessionWorkflow(h);
                const keyD = `rr4-concurrent-${randomUUID()}`;
                let claimedD = null;
                let releaseA;
                const aMayRefuse = new Promise(resolve => { releaseA = resolve; });
                let aEntered;
                const aInAdmission = new Promise(resolve => { aEntered = resolve; });
                const refusingHost = { ...h, store: Object.assign(Object.create(h.store), {
                    createDefinition: async (arg) => {
                        claimedD = arg.workflowSessionId;
                        aEntered();
                        await aMayRefuse;
                        throw new WorkflowStoreError("RERUN_APPROVAL_REUSED", "simulated: another actor may not reuse the answered approval");
                    },
                }) };
                const startA = startSessionWorkflowDefinition(refusingHost, rerunOf(srcD, { operationId: "rr4-a", key: keyD }));
                const settledA = startA.then(() => null, error => error);
                await aInAdmission;
                const b = await startSessionWorkflowDefinition(h, rerunOf(srcD, { operationId: "rr4-b", key: keyD }));
                expect(b.workflowId).toBe(claimedD);
                expect(b.runId).toBeTruthy();
                releaseA();
                const errorA = await settledA;
                expect(errorA).toBeInstanceOf(WorkflowStoreError);
                expect(errorA.code).toBe("RERUN_APPROVAL_REUSED");
                expect((await shellRow(b.workflowId))?.deleted_at).toBeNull();
                const { rows: runsD } = await pool.query(`SELECT run_id FROM ${s}.workflow_runs WHERE workflow_session_id = $1`, [b.workflowId]);
                expect(runsD.map(r => r.run_id)).toEqual([b.runId]);
            } finally {
                await pool.end();
            }
        });
    });
});
