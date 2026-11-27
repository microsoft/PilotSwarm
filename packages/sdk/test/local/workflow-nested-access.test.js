/**
 * I2: who may read and control a nested Workflow with the agent tools (read_workflow, update_workflow, send_workflow_input),
 * on the stored session rows of PostgreSQL:
 * - the Workflow's parent, and every session above it in the same owner's tree (grandparent, great-grandparent through three
 *   nested Workflows), may read it and control it (pause, resume, set_vars, stop, cancel, recover);
 * - only the parent saves and starts definitions (a definition operation of an ancestor is refused);
 * - the Workflow's own agent step, and a sub-agent of that step, may read it but not control it;
 * - a sibling session, another user's session, a session above a deleted session and a session of another owner above the
 *   Workflow are refused, each with a message that names the rule;
 * - an ancestor reads a cleaned-up Workflow through the outcome kept with its parent;
 * - send_workflow_input keeps its rule (the parent, or any session of the same user): an ancestor of the same user may send.
 *
 * Run: npx vitest run test/local/workflow-nested-access.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { WORKFLOW_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { readWorkflowFromTool, sendWorkflowInputFromTool, updateWorkflowFromTool } from "../../src/workflow/tools.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-nested-access-test" };
const OWNER_A = { provider: "test", subject: "nested-access-alice" };
const OWNER_B = { provider: "test", subject: "nested-access-bob" };

const RECEIVER_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: batch, version: "1.0.0" }
contracts:
  Ping@1: { schema: { type: object } }
initial: listen
states:
  listen:
    type: messaging
    mode: receive
    contract: Ping@1
    wait: { seconds: 3600 }
    transition: { next: { received: done, elapsed: done } }
  done: { type: terminal, outcome: succeeded }
`;

const AGENT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: coder, version: "1.0.0" }
initial: code
schemas:
  Result: { type: object, required: [verdict], properties: { verdict: { type: string } }, additionalProperties: false }
states:
  code:
    type: agent
    invoke: { prompt: "Write it." }
    outputSchema: { $ref: "#/schemas/Result" }
    timeoutSeconds: 3600
    transition: { next: { accepted: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

/** A started Workflow under `parent`, as a Start or a spawn state creates one: its session row, definition and live run. */
async function workflowOf(h, parent, owner, yaml = RECEIVER_YAML) {
    const compiled = compileWorkflow(yaml);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await h.catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner,
        creationConfig: { workflow: { requestSha256: "nested-access" } } })).toEqual({ created: true });
    await h.store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "nested-access", publish: true, title: `Workflow: ${compiled.name}`,
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
            inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION },
    });
    return { workflowSessionId, runId };
}

/** The agent step of `workflow` (an agent-state Workflow): its pending visit's invocation record and its session. */
async function agentStepOf(h, workflow, controllingSessionId, owner) {
    const childSessionId = randomUUID();
    const nodeExecutionId = nodeExecutionIdFor(workflow.runId, "root", "code", 1);
    expect(await h.store.enterNode({
        runId: workflow.runId, nodeExecutionId, scopeId: "root", nodeId: "code", ordinal: 1, nodeType: "agent", predecessorId: null,
        arrivalRoute: null, inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
        agent: { childSessionId, controllingSessionId, task: { source: "prompt", prompt: "Write it." }, outcomes: ["accepted"],
            outputSchema: "Result", timeoutSeconds: 3600 },
    })).toMatchObject({ admitted: true, inserted: true });
    await h.catalog.createSession(childSessionId, { parentSessionId: workflow.workflowSessionId, owner });
    return childSessionId;
}

function hostOf(h) {
    return {
        catalog: h.catalog, store: h.store,
        duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} },
    };
}

const PARENT_RULE = /^Only a session above this Workflow \(the session that started it, or one above that\) may read or control it/;

describe("I2: nested Workflows are read and controlled by every session above them", () => {
    it("parent, grandparent and great-grandparent read and control; the agent step and its sub-agent read only; others are refused", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const read = async (caller, workflowId, args = {}) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId, ...args },
                { callerSessionId: caller, host }));
            const update = async (caller, workflowId, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args },
                { callerSessionId: caller, host }));

            // top → W1 (batch) → W2 (child Workflow) → W3 (grandchild Workflow, an agent state) → C (its agent step) → G (C's sub-agent).
            const top = randomUUID();
            await h.catalog.createSession(top, { owner: OWNER_A });
            const w1 = await workflowOf(h, top, OWNER_A);
            const w2 = await workflowOf(h, w1.workflowSessionId, OWNER_A);
            const w3 = await workflowOf(h, w2.workflowSessionId, OWNER_A, AGENT_YAML);
            const step = await agentStepOf(h, w3, w2.workflowSessionId, OWNER_A);
            const sub = randomUUID();
            await h.catalog.createSession(sub, { parentSessionId: step, owner: OWNER_A });
            // A sibling: another sub-agent of top. Another user's session, unrelated.
            const sibling = randomUUID();
            await h.catalog.createSession(sibling, { parentSessionId: top, owner: OWNER_A });
            const stranger = randomUUID();
            await h.catalog.createSession(stranger, { owner: OWNER_B });

            // Reads: the parent (top of W1), the grandparent (top of W2), the great-grandparent (top of W3, three nested Workflows).
            for (const [label, workflow] of [["parent", w1], ["grandparent", w2], ["great-grandparent", w3]]) {
                const view = await read(top, workflow.workflowSessionId);
                expect(view.ok, `${label}: ${JSON.stringify(view.error)}`).toBe(true);
                expect(view.workflowId).toBe(workflow.workflowSessionId);
                expect(view.run.runId).toBe(workflow.runId);
            }
            // The agent step reads its own Workflow, and so does its sub-agent.
            for (const [label, caller] of [["agent step", step], ["sub-agent of the step", sub]]) {
                const view = await read(caller, w3.workflowSessionId);
                expect(view.ok, `${label}: ${JSON.stringify(view.error)}`).toBe(true);
                expect(view.run.runId).toBe(w3.runId);
            }

            // Control: each ancestor pauses, resumes, sets variables and recovers its descendant.
            for (const [label, workflow] of [["parent", w1], ["grandparent", w2], ["great-grandparent", w3]]) {
                const tag = label.replace(/\W/g, "-");
                const paused = await update(top, workflow.workflowSessionId, { operation: "pause", operation_id: `pause-${tag}` });
                expect(paused.ok, `${label} pause: ${JSON.stringify(paused.error)}`).toBe(true);
                expect(paused.status).toBe("paused");
                const resumed = await update(top, workflow.workflowSessionId, { operation: "resume", operation_id: `resume-${tag}` });
                expect(resumed.ok, `${label} resume: ${JSON.stringify(resumed.error)}`).toBe(true);
                const vars = await update(top, workflow.workflowSessionId, { operation: "set_vars", operation_id: `vars-${tag}`,
                    set: { by: label }, expected_kv_revision: 1 });
                expect(vars.ok, `${label} set_vars: ${JSON.stringify(vars.error)}`).toBe(true);
                expect(vars.kvRevision).toBe(2);
                const recovered = await update(top, workflow.workflowSessionId, { operation: "recover", operation_id: `recover-${tag}` });
                expect(recovered.ok, `${label} recover: ${JSON.stringify(recovered.error)}`).toBe(true);
                expect(recovered.action).toBe("none");
            }
            // The last control shows who took it: another session (top), seen from the agent step's read.
            const seen = await read(step, w3.workflowSessionId);
            expect(seen.run.lastControl).toMatchObject({ operation: "set_vars", by: "another session", sessionId: top });

            // Saving and starting definitions stay with the parent: an ancestor's definition operation is refused.
            const started = await update(top, w2.workflowSessionId, { operation: "start", operation_id: "start-by-grandparent",
                definition_hash: "h", inputs: {} });
            expect([started.ok, started.error?.code]).toEqual([false, "FORBIDDEN"]);
            expect(started.error.message).toMatch(/^Only the session that started this Workflow may save or start its definition/);

            // The agent step and its sub-agent may not control their Workflow.
            for (const [label, caller] of [["agent step", step], ["sub-agent of the step", sub]]) {
                for (const args of [{ operation: "pause" }, { operation: "cancel" }, { operation: "recover" },
                    { operation: "set_vars", set: { x: 1 }, expected_kv_revision: 2 }]) {
                    const refused = await update(caller, w3.workflowSessionId, { ...args, operation_id: `${label}-${args.operation}` });
                    expect([refused.ok, refused.error?.code], `${label} ${args.operation}`).toEqual([false, "FORBIDDEN"]);
                    expect(refused.error.message).toBe("An agent step, and a session under it, may read its own Workflow but not control it.");
                }
                // Nor read another Workflow of the tree: W2 is not its own Workflow.
                const other = await read(caller, w2.workflowSessionId);
                expect([other.ok, other.error?.code], `${label} reads W2`).toEqual([false, "FORBIDDEN"]);
                expect(other.error.message).toMatch(PARENT_RULE);
            }

            // A sibling and another user's session are refused, read and control alike.
            for (const [label, caller] of [["sibling", sibling], ["another user's session", stranger]]) {
                for (const workflow of [w1, w2, w3]) {
                    const refusedRead = await read(caller, workflow.workflowSessionId);
                    expect([refusedRead.ok, refusedRead.error?.code], `${label} read`).toEqual([false, "FORBIDDEN"]);
                    expect(refusedRead.error.message).toMatch(PARENT_RULE);
                    const refusedPause = await update(caller, workflow.workflowSessionId, { operation: "pause", operation_id: `${label}-pause` });
                    expect([refusedPause.ok, refusedPause.error?.code], `${label} pause`).toEqual([false, "FORBIDDEN"]);
                }
            }

            // Stop and cancel by the great-grandparent end the grandchild Workflow; the cancel names who cancelled it.
            const stopped = await update(top, w3.workflowSessionId, { operation: "stop", operation_id: "stop-w3", grace_seconds: 0 });
            expect(stopped.ok, JSON.stringify(stopped.error)).toBe(true);
            const cancelled = await update(top, w2.workflowSessionId, { operation: "cancel", operation_id: "cancel-w2" });
            expect(cancelled.ok, JSON.stringify(cancelled.error)).toBe(true);
            const w2Run = await h.store.readRun(w2.runId);
            expect(w2Run.status).toBe("cancelled");

            // send_workflow_input keeps its rule: an ancestor of the same user may send; another user's session may not.
            const sent = JSON.parse(await sendWorkflowInputFromTool({ workflow_id: w1.workflowSessionId, contract: "Ping@1", payload: { n: 1 },
                operation_id: "ping-from-top" }, { callerSessionId: top, host }));
            expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
            const foreign = JSON.parse(await sendWorkflowInputFromTool({ workflow_id: w1.workflowSessionId, contract: "Ping@1", payload: { n: 2 },
                operation_id: "ping-from-stranger" }, { callerSessionId: stranger, host }));
            expect([foreign.ok, foreign.error?.code]).toEqual([false, "FORBIDDEN"]);
        } finally {
            await h.stop();
        }
    });

    it("refuses a session above a deleted session, and a session of another owner above the Workflow", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const read = async (caller, workflowId) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId }, { callerSessionId: caller, host }));
            const update = async (caller, workflowId, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args },
                { callerSessionId: caller, host }));

            // top → s1 → s2 → W: deleting s1 (an ordinary session, as a cleanup without cascade does) breaks the chain above s2.
            const top = randomUUID();
            await h.catalog.createSession(top, { owner: OWNER_A });
            const s1 = randomUUID();
            await h.catalog.createSession(s1, { parentSessionId: top, owner: OWNER_A });
            const s2 = randomUUID();
            await h.catalog.createSession(s2, { parentSessionId: s1, owner: OWNER_A });
            const w = await workflowOf(h, s2, OWNER_A);
            expect((await read(top, w.workflowSessionId)).ok, "allowed before the delete").toBe(true);
            await h.catalog.softDeleteSession(s1);
            expect((await h.catalog.getSession(w.workflowSessionId)).deletedAt, "the Workflow itself is not deleted").toBeNull();
            const broken = await read(top, w.workflowSessionId);
            expect([broken.ok, broken.error?.code]).toEqual([false, "FORBIDDEN"]);
            expect(broken.error.message).toBe("A session between this session and the Workflow was deleted, so this session may no longer read or control it.");
            const brokenPause = await update(top, w.workflowSessionId, { operation: "pause", operation_id: "pause-broken" });
            expect([brokenPause.ok, brokenPause.error?.code]).toEqual([false, "FORBIDDEN"]);
            // The parent below the deleted session keeps its rights.
            expect((await read(s2, w.workflowSessionId)).ok).toBe(true);
            const parentPause = await update(s2, w.workflowSessionId, { operation: "pause", operation_id: "pause-by-parent" });
            expect(parentPause.ok, JSON.stringify(parentPause.error)).toBe(true);

            // bob's session → alice's sub-agent → alice's Workflow: bob is above the Workflow but is another owner.
            const bobTop = randomUUID();
            await h.catalog.createSession(bobTop, { owner: OWNER_B });
            const aliceSub = randomUUID();
            await h.catalog.createSession(aliceSub, { parentSessionId: bobTop, owner: OWNER_A });
            const aliceWorkflow = await workflowOf(h, aliceSub, OWNER_A);
            const crossOwner = await read(bobTop, aliceWorkflow.workflowSessionId);
            expect([crossOwner.ok, crossOwner.error?.code]).toEqual([false, "FORBIDDEN"]);
            expect(crossOwner.error.message).toBe("This session belongs to another owner than the Workflow, so it may not read or control it.");
            expect((await read(aliceSub, aliceWorkflow.workflowSessionId)).ok, "the Workflow's own parent").toBe(true);
        } finally {
            await h.stop();
        }
    });

    it("an ancestor reads a cleaned-up Workflow through the outcome kept with its parent", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const read = async (caller, workflowId) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId }, { callerSessionId: caller, host }));
            const top = randomUUID();
            await h.catalog.createSession(top, { owner: OWNER_A });
            const w1 = await workflowOf(h, top, OWNER_A);
            const w2 = await workflowOf(h, w1.workflowSessionId, OWNER_A);
            const stranger = randomUUID();
            await h.catalog.createSession(stranger, { owner: OWNER_B });
            await h.q(`UPDATE SCHEMA.workflow_runs SET status = 'completed', terminal_outcome = 'succeeded', terminal_node_id = 'done',
                terminal_output = '{"summary":"kept"}', finished_at = now() WHERE run_id = $1`, [w2.runId]);
            await h.q("SELECT SCHEMA.workflow_record_terminal_outcome($1)", [w2.runId]);
            await h.catalog.softDeleteSession(w2.workflowSessionId);
            const kept = await read(top, w2.workflowSessionId);
            expect(kept.ok, JSON.stringify(kept.error)).toBe(true);
            expect(kept.deleted).toBe(true);
            expect(kept.run).toMatchObject({ runId: w2.runId, status: "completed", outcome: "succeeded", output: '{"summary":"kept"}' });
            const refused = await read(stranger, w2.workflowSessionId);
            expect([refused.ok, refused.error?.code]).toEqual([false, "WORKFLOW_NOT_FOUND"]);
        } finally {
            await h.stop();
        }
    });
});
