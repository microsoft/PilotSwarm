/**
 * Stage 2.4 (PR 235 2b893906), on PostgreSQL: Start keeps spawn_agent's budget of running children. The session's running
 * children are its running sub-agents and its Workflows whose live run is active; not its idle or ended sub-agents, its
 * system or service sessions (an agent's test benches) or its deleted ones. At 50, Start is refused (CHILD_LIMIT) and
 * nothing is made; the depth limit refuses a session at the deepest level (WORKFLOW_NESTING_LIMIT).
 * No model, no controller: a started run stays admitted (a recording duroxide client stands in for the dispatch).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import {
    saveSessionWorkflowDefinition, startSessionWorkflowDefinition, WORKFLOW_START_MAX_RUNNING_CHILDREN,
} from "../../src/workflow/session-definitions.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "start-limits" };
const ENGINE = { kind: "system", name: "start-limits-test" };
const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: waiter, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 600, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

async function refused(promise, code) {
    let caught = null;
    try { await promise; } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    return caught;
}

describe("Start keeps spawn_agent's limits (stage 2.4)", () => {
    it("counts running sub-agents and active Workflows only, refuses the 51st, and refuses a session at the deepest level", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = { catalog: h.catalog, store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} } };
            const session = randomUUID();
            await h.catalog.createSession(session, { owner: OWNER });
            const id = (await saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: "waiter", yaml: YAML, expected: null,
                actor: { kind: "session", sessionId: session }, operationId: "save-1", by: "session" })).receipt.definitionId;
            const start = (operationId, extra = {}) => startSessionWorkflowDefinition(host, { ownerSessionId: session, definition: { definitionId: id }, inputs: {},
                actor: ENGINE, operationId, ...extra });
            // Children that do not count: idle, ended, system, service (a test bench) and deleted ones.
            const child = async (state, extra = {}) => {
                const sessionId = randomUUID();
                await h.catalog.createSession(sessionId, { parentSessionId: session, owner: OWNER, ...extra });
                await h.q("UPDATE SCHEMA.sessions SET state = $2 WHERE session_id = $1", [sessionId, state]);
                return sessionId;
            };
            await child("idle");
            await child("completed");
            await child("running", { isSystem: true });
            const bench = await child("running");
            await h.catalog.markSessionService(bench, "workflow-test", null);
            const gone = await child("running");
            await h.catalog.softDeleteSession(gone);
            expect(await h.store.sessionDefinitions.runningChildren(session)).toBe(0);
            // Two active Workflows and 47 running sub-agents: 49.
            await start("start-1");
            await start("start-2");
            for (let index = 0; index < WORKFLOW_START_MAX_RUNNING_CHILDREN - 3; index += 1) await child("running");
            expect(await h.store.sessionDefinitions.runningChildren(session)).toBe(49);
            const fiftieth = await start("start-3");
            expect(fiftieth.revision).toBe(1);
            expect(await h.store.sessionDefinitions.runningChildren(session)).toBe(50);
            const before = (await h.store.sessionDefinitions.listWorkflows({ definitionId: id })).length;
            const full = await refused(start("start-4"), "CHILD_LIMIT");
            expect(full.message).toMatch(/^This session already has 50 running sub-agents and Workflows \(max 50\)\./);
            expect((await h.store.sessionDefinitions.listWorkflows({ definitionId: id })).length).toBe(before);
            // A repeat of a start that made its Workflow is answered from its receipt, not refused.
            expect((await start("start-3")).workflowId).toBe(fiftieth.workflowId);
            // A Workflow that ends frees its place.
            await h.q("UPDATE SCHEMA.workflow_runs SET status = 'completed', finished_at = now() WHERE workflow_session_id = $1", [fiftieth.workflowId]);
            expect(await h.store.sessionDefinitions.runningChildren(session)).toBe(49);
            expect((await start("start-5")).revision).toBe(1);
            // The depth limit: a session at level 2 starts nothing.
            const other = randomUUID();
            await h.catalog.createSession(other, { owner: OWNER });
            const otherId = (await saveSessionWorkflowDefinition(host, { ownerSessionId: other, name: "waiter", yaml: YAML, expected: null,
                actor: { kind: "session", sessionId: other }, operationId: "save-2", by: "session" })).receipt.definitionId;
            await refused(startSessionWorkflowDefinition(host, { ownerSessionId: other, definition: { definitionId: otherId }, inputs: {}, actor: ENGINE,
                operationId: "deep", nestingLevel: 2 }), "WORKFLOW_NESTING_LIMIT");
            expect((await startSessionWorkflowDefinition(host, { ownerSessionId: other, definition: { definitionId: otherId }, inputs: {}, actor: ENGINE,
                operationId: "child-level", nestingLevel: 1 })).revision).toBe(1);
        } finally {
            await h.stop();
        }
    });
});
