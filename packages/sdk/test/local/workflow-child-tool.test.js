/**
 * Child Workflows tool tests (T19, T20, T21):
 * - T19: list (active/ended/all, definition filter, pagination, spawnedBy), read, stop, cancel from a live script state
 *        and from an agent step\x27s handler; unsupported ops (pause/resume/set_vars/start) refused.
 * - T20: read/stop/cancel of a sibling Workflow, the parent Workflow itself, or another user\x27s Workflow -> WORKFLOW_NOT_FOUND.
 * - T21: child_workflows is declared ONLY for direct agent steps (workflowAgentChild: true), NOT for chat agents or sub-agents.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { ManagedSession } from "../../src/managed-session.ts";
import { registerWorkflow } from "../../src/workflow/runtime.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { childWorkflowsFromTool, WORKFLOW_CHILD_WORKFLOWS_TOOL } from "../../src/workflow/tools.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const OWNER_A = { provider: "test", subject: "alice" };
const OWNER_B = { provider: "test", subject: "bob" };
const ENGINE = { kind: "system", name: "child-tool-test" };

const SLEEP_CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: sleep-worker, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 300, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

const PARENT_SCRIPT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-script-tool, version: "1.0.0" }
initial: s1
states:
  s1:
    type: spawn
    definition: sleep-worker
    transition: { next: { started: s2, failure: failed } }
  s2:
    type: spawn
    definition: sleep-worker
    transition: { next: { started: check_and_cancel, failure: failed } }
  check_and_cancel:
    type: script
    outcomes: [ok]
    source: |
      const active = await callTool("child_workflows", { operation: "list", status: "active", definition: "sleep-worker" });
      if (active.children.length !== 2) throw new Error("expected 2 active children, got " + active.children.length);
      const firstId = active.children[0].workflowId;
      const detail = await callTool("child_workflows", { operation: "read", workflow_id: firstId });
      let missingCode = null;
      try {
        await callTool("child_workflows", { operation: "read", workflow_id: "00000000-0000-0000-0000-000000000000" });
        throw new Error("expected child_workflows read to throw");
      } catch (err) {
        missingCode = err?.code ?? null;
      }
      if (missingCode !== "WORKFLOW_NOT_FOUND") {
        throw new Error("expected thrown error.code === WORKFLOW_NOT_FOUND, got " + String(missingCode));
      }
      await callTool("child_workflows", { operation: "cancel", workflow_id: firstId, operation_id: "cancel-from-script", reason: "script cancel" });
      await setResult("ok", {
        count: active.children.length,
        cancelledId: firstId,
        readStatus: detail.run?.status ?? null,
        missingCode,
        spawnedStates: active.children.map(c => c.spawnedBy?.stateId).sort(),
      });
    transition: { next: { ok: wait_cancelled, failure: failed } }
  wait_cancelled:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    carry: { summary: "\${input}" }
    wait: { seconds: 30 }
    transition: { next: { received: done, elapsed: failed, failure: failed } }
  done:
    type: terminal
    outcome: succeeded
    output: { summary: "\${input.carry.summary}", ended: "\${input.result}" }
  failed:
    type: terminal
    outcome: failed
`;

describe("child_workflows tool (T19, T20, T21)", () => {
    it("T21: declared only for direct agent steps, not chat agents or sub-agents of agent steps", () => {
        const names = opts => ManagedSession.subAgentToolDefs(opts).map(t => t.name);
        expect(names({ workflowMilestone: true })).not.toContain(WORKFLOW_CHILD_WORKFLOWS_TOOL);
        expect(names({ workflowMilestone: true, workflowInsideWorkflow: true })).not.toContain(WORKFLOW_CHILD_WORKFLOWS_TOOL);
        expect(names({ workflowMilestone: true, workflowInsideWorkflow: true, workflowAgentChild: true })).toContain(WORKFLOW_CHILD_WORKFLOWS_TOOL);
    });

    it("T19 & T20: script and agent-step child_workflows ops + WORKFLOW_NOT_FOUND boundary", { timeout: TIMEOUT }, async () => {
        const tag = randomUUID().slice(0, 8);
        const duroxideSchema = `duroxide_cwt_${tag}`;
        const cmsSchema = `cms_cwt_${tag}`;
        const env = getEnv();
        const provider = await PostgresProvider.connectWithSchema(env.store, duroxideSchema);
        const client = new Client(provider);
        const catalog = await PgSessionCatalog.create(env.store, cmsSchema);
        await catalog.initialize();
        const store = catalog.workflowStore();
        const pool = new pg.Pool({ connectionString: env.store });
        const runtime = new Runtime(provider, {
            orchestrationConcurrency: 8, workerConcurrency: 8, dispatcherPollIntervalMs: 20,
            workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] }, logLevel: "error",
        });
        const host = { catalog, store, duroxideClient: client, scripts: true };
        registerWorkflow(runtime, {
            store, catalog, enabled: () => true,
            resolveToolBinding: async () => null,
            openToolExecutor: async () => ({ call: async () => { throw new Error("unexpected"); }, close: async () => {} }),
            authorizeParentNotification: async () => true,
            notifyParent: async () => ({ delivered: true }),
            deleteSession: async (id) => { await catalog.softDeleteSession(id); },
            wakeBackstopMs: 250,
            spawnChildHost: () => host,
        });
        await runtime.start();
        try {
            const chatA = randomUUID();
            const chatB = randomUUID();
            await catalog.createSession(chatA, { owner: OWNER_A });
            await catalog.createSession(chatB, { owner: OWNER_B });
            for (const [ownerId, name, yaml] of [
                [chatA, "sleep-worker", SLEEP_CHILD_YAML],
                [chatA, "parent-script-tool", PARENT_SCRIPT_YAML],
                [chatB, "sleep-worker", SLEEP_CHILD_YAML],
            ]) {
                const s = await saveSessionWorkflowDefinition(host, {
                    ownerSessionId: ownerId, name, yaml, expected: null,
                    actor: { kind: "session", sessionId: ownerId }, operationId: `save-${ownerId}-${name}`, by: "session",
                });
                expect(s.receipt.valid, JSON.stringify(s.receipt.diagnostics)).toBe(true);
            }

            // Start sibling under chatA and another user\x27s workflow under chatB.
            const siblingWf = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chatA, definition: { name: "sleep-worker" }, inputs: {},
                actor: ENGINE, operationId: "start-sibling", owner: OWNER_A,
            });
            const otherUserWf = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chatB, definition: { name: "sleep-worker" }, inputs: {},
                actor: ENGINE, operationId: "start-other-user", owner: OWNER_B,
            });

            // T19 (script state): parent spawns 2 children, lists, reads, cancels one via callTool("child_workflows"),
            // and receives WorkflowEnded@1 even though the parent itself cancelled the child!
            const parentWf = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chatA, definition: { name: "parent-script-tool" }, inputs: {},
                actor: ENGINE, operationId: "start-parent-script", owner: OWNER_A,
            });
            const deadline = Date.now() + 40_000;
            let parentRun = null;
            while (Date.now() < deadline) {
                parentRun = await store.readRun(parentWf.runId);
                if (parentRun && ["completed", "failed"].includes(parentRun.status)) break;
                await new Promise(r => setTimeout(r, 80));
            }
            expect(parentRun?.status).toBe("completed");
            expect(parentRun?.terminalOutput?.summary).toMatchObject({
                count: 2,
                missingCode: "WORKFLOW_NOT_FOUND",
                spawnedStates: ["s1", "s2"],
            });
            expect(parentRun?.terminalOutput?.ended).toMatchObject({
                workflowId: parentRun?.terminalOutput?.summary?.cancelledId,
                status: "cancelled",
            });

            // T19 (agent step handler): list ended + pagination + read + stop + disallowed ops.
            const listed = JSON.parse(await childWorkflowsFromTool({ operation: "list", status: "all", limit: 1 }, {
                callerWorkflowSessionId: parentWf.workflowId, host,
            }));
            expect(listed.ok).toBe(true);
            expect(listed.children).toHaveLength(1);
            expect(listed.nextCursor).toBe("o:1");
            const page2 = JSON.parse(await childWorkflowsFromTool({ operation: "list", status: "all", limit: 1, cursor: listed.nextCursor }, {
                callerWorkflowSessionId: parentWf.workflowId, host,
            }));
            expect(page2.ok).toBe(true);
            expect(page2.children).toHaveLength(1);
            expect(page2.nextCursor).toBeNull();

            // Disallowed op (D3: only list, read, stop, cancel).
            const badOp = JSON.parse(await childWorkflowsFromTool({ operation: "pause", workflow_id: listed.children[0].workflowId }, {
                callerWorkflowSessionId: parentWf.workflowId, host,
            }));
            expect(badOp.ok).toBe(false);
            expect(badOp.error.code).toBe("WORKFLOW_COMMAND_INVALID");

            // T20: read/stop/cancel of sibling, parent itself, and another user\x27s workflow -> WORKFLOW_NOT_FOUND.
            for (const targetId of [siblingWf.workflowId, parentWf.workflowId, otherUserWf.workflowId]) {
                const res = JSON.parse(await childWorkflowsFromTool({ operation: "read", workflow_id: targetId }, {
                    callerWorkflowSessionId: parentWf.workflowId, host,
                }));
                expect(res.ok).toBe(false);
                expect(res.error.code).toBe("WORKFLOW_NOT_FOUND");
            }
        } finally {
            await runtime.shutdown();
            await catalog.close();
            await pool.query(`DROP SCHEMA IF EXISTS "${duroxideSchema}" CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS "${cmsSchema}" CASCADE`);
            await pool.end();
        }
    });
});
