import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import { WORKFLOW_TOOL_POLICY } from "../../src/workflow/tool-policy.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { WorkflowStoreError, nodeExecutionIdFor } from "../../src/workflow/store.ts";

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
            const id = nodeExecutionIdFor(started.runId, "root", v.nodeId, v.ordinal);
            const inputText = canonicalJson(v.input ?? {});
            const outputText = v.resultKind === "business" ? canonicalJson(v.output ?? null) : null;
            const errorText = v.resultKind === "runtime_error" ? canonicalJson(v.error ?? { code: v.outcome ?? "err", message: "err" }) : null;
            await pool.query(
                `INSERT INTO ${s}.workflow_node_executions (
                    node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                    input, input_sha256, state, outcome, result_kind, output, error, winner,
                    effect_attempts, entered_at, completed_at, kv_revision, deadline_at
                 ) VALUES ($1,$2,'root',$3,$4,$5,$6,$7,$8,$9,'completed',$10,$11,$12,$13,$14,1,$15::timestamptz,$16::timestamptz,1,NULL)`,
                [
                    id, started.runId, prev, v.nodeId, v.ordinal, v.nodeType, v.arrivalRoute ?? null,
                    inputText, sha256Hex(inputText), v.outcome ?? "ok", v.resultKind ?? "business",
                    outputText, errorText, v.winner ?? "effect",
                    new Date(baseMs + i * 1000).toISOString(), new Date(baseMs + i * 1000 + 400).toISOString(),
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
            prev = id;
        }
        if (!opts.leaveActive) {
            await pool.query(`UPDATE ${s}.workflow_runs SET status = 'failed', finished_at = now() WHERE run_id = $1`, [started.runId]);
        }
        return { ownerSessionId, definitionId, workflowId: started.workflowId, runId: started.runId, ids };
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
});
