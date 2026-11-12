/**
 * A parent session's lifecycle command is authorized against the Workflow's parent BEFORE the store transaction
 * (applyLifecycleCommandToWorkflow reads the session link and the definition with no lock), and the store then takes
 * the session and definition locks. Until recordSessionCommand re-checked the parent under those locks, the
 * authorization and the write it authorized were in different transactions, so a writer that changed the Workflow's
 * parent in between would leave the OLD parent able to end a run that by then belonged to another session.
 *
 * Nothing changes a Workflow's parent today, so this test makes the change itself, from a second connection, in the
 * window the fence is there to close: it is a test of the invariant, not of an observed failure. Without the fence
 * the command is accepted and the run is cancelled; with it the command is refused and the run is untouched.
 *
 * Run: npx vitest run test/local/workflow-command-parent-fence.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "workflow-command-parent-fence" };
const ENGINE = { kind: "system", name: "workflow-command-parent-fence-test" };
const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: waiter, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 3600, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

describe("a lifecycle command is authorized against the parent the store locks, not the one the caller read", () => {
    it("refuses a cancel from a session that is no longer the Workflow's parent, and leaves the run active", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        const direct = new pg.Pool({ connectionString: env.store, max: 2 });
        try {
            const host = {
                catalog: h.catalog, store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} },
            };
            const oldParent = randomUUID();
            const newParent = randomUUID();
            await h.catalog.createSession(oldParent, { owner: OWNER });
            await h.catalog.createSession(newParent, { owner: OWNER });

            const saved = (await saveSessionWorkflowDefinition(host, {
                ownerSessionId: oldParent, name: "waiter", yaml: YAML, expected: null,
                actor: { kind: "session", sessionId: oldParent }, operationId: "save-1", by: "session",
            })).receipt;
            const started = await startSessionWorkflowDefinition(host, {
                ownerSessionId: oldParent, definition: { definitionId: saved.definitionId }, inputs: {},
                actor: ENGINE, operationId: "start-1",
            });
            const workflowSessionId = started.workflowId;
            expect(workflowSessionId, "the Start returned a Workflow session id").toBeTruthy();

            const runBefore = await h.store.readRun(started.runId);
            expect(runBefore?.status, "the run is active before the command").toBe("admitted");

            // The window the fence closes: the parent moves after the caller's unlocked check would have passed.
            // Both copies move together, as any real operation would have to.
            const schema = env.cmsSchema;
            await direct.query(`UPDATE "${schema}".sessions SET parent_session_id = $2 WHERE session_id = $1`, [workflowSessionId, newParent]);
            await direct.query(`UPDATE "${schema}".workflow_definitions SET parent_session_id = $2 WHERE workflow_session_id = $1`,
                [workflowSessionId, newParent]);

            // The old parent now sends the cancel it was authorized for a moment ago.
            // Asserted by CODE, not by message text: the code is the contract a caller branches on.
            const refused = await h.store.recordSessionCommand({
                workflowSessionId, operationId: "cancel-by-old-parent", requestSha256: "sha-1",
                command: "cancel", reason: "Cancelled by its parent", requestedBy: oldParent,
                expectedParentSessionId: oldParent,
            }).then(() => null, error => error);
            expect(refused, "the stale parent's cancel is refused").toBeTruthy();
            expect(refused.code, "refused with the FORBIDDEN contract").toBe("FORBIDDEN");

            const runAfter = await h.store.readRun(started.runId);
            expect(runAfter?.status, "the run is untouched by the refused command").toBe("admitted");

            // The session that IS the parent now is still able to end it, so the fence refuses the stale caller only.
            const accepted = await h.store.recordSessionCommand({
                workflowSessionId, operationId: "cancel-by-new-parent", requestSha256: "sha-2",
                command: "cancel", reason: "Cancelled by its parent", requestedBy: newParent,
                expectedParentSessionId: newParent,
            });
            expect(accepted.receipt.applied, "the current parent's cancel is applied").toBe("store");
        } finally {
            // The direct pool first, so a failure stopping the fixture cannot strand it. Teardown errors are NOT
            // swallowed: a fixture that fails to stop leaks a PostgreSQL pool into the rest of the suite.
            await direct.end();
            await h.stop();
        }
    });

    it("an operator's command carries no expected parent and is unaffected", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        try {
            const host = {
                catalog: h.catalog, store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} },
            };
            const owner = randomUUID();
            await h.catalog.createSession(owner, { owner: OWNER });
            const saved = (await saveSessionWorkflowDefinition(host, {
                ownerSessionId: owner, name: "waiter", yaml: YAML, expected: null,
                actor: { kind: "session", sessionId: owner }, operationId: "save-2", by: "session",
            })).receipt;
            const started = await startSessionWorkflowDefinition(host, {
                ownerSessionId: owner, definition: { definitionId: saved.definitionId }, inputs: {},
                actor: ENGINE, operationId: "start-2",
            });
            const workflowSessionId = started.workflowId;

            // requestedBy null, expectedParentSessionId omitted: the path a management-API caller takes, unchanged.
            const accepted = await h.store.recordSessionCommand({
                workflowSessionId, operationId: "cancel-by-operator", requestSha256: "sha-3",
                command: "cancel", reason: "Cancelled by an operator", requestedBy: null,
            });
            expect(accepted.receipt.applied, "an operator's cancel is applied with no parent check").toBe("store");
        } finally {
            await h.stop();
        }
    });
});
