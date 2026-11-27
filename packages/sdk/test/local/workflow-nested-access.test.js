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
 * - send_workflow_input keeps its rule (the parent, or any session of the same user): an ancestor of the same user may send;
 * - owner classes as built (owner decision 2026-11-26, kept): in an all-unowned tree an ancestor reads and cancels a nested
 *   Workflow (typed input stays with the parent); a system root is another owner to the Workflows below its direct child.
 *
 * Run: npx vitest run test/local/workflow-nested-access.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { WORKFLOW_CONTROLLER_VERSION, WORKFLOW_ENDED_NOTICE_MAX_BYTES, workflowEndedNoticeFits, workflowLiveControllerInstanceId,
    workflowTestControllerInstanceId } from "../../src/workflow/runtime.ts";
import { canonicalJson, utf8ByteLength } from "../../src/workflow/json.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { resolveEffectiveSpawnOwner } from "../../src/cms.ts";
import { childWorkflowsFromTool, readWorkflowFromTool, sendWorkflowInputFromTool, updateWorkflowFromTool } from "../../src/workflow/tools.ts";

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
async function workflowOf(h, parent, owner, yaml = RECEIVER_YAML, { draft = false } = {}) {
    const compiled = compileWorkflow(yaml);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await h.catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner,
        creationConfig: { workflow: { requestSha256: "nested-access" } } })).toEqual({ created: true });
    await h.store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "nested-access", publish: !draft, title: `Workflow: ${compiled.name}`,
        start: draft ? null : { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
            inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION },
    });
    return { workflowSessionId, runId: draft ? null : runId, compiled };
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

            // send_workflow_input keeps its rule: the grandparent (not W2's parent, the same user) may send to W2; another user's
            // session may not.
            const sent = JSON.parse(await sendWorkflowInputFromTool({ workflow_id: w2.workflowSessionId, contract: "Ping@1", payload: { n: 1 },
                operation_id: "ping-from-top" }, { callerSessionId: top, host }));
            expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
            expect([sent.workflowId, sent.runId, sent.senderSessionId]).toEqual([w2.workflowSessionId, w2.runId, top]);
            const foreign = JSON.parse(await sendWorkflowInputFromTool({ workflow_id: w2.workflowSessionId, contract: "Ping@1", payload: { n: 2 },
                operation_id: "ping-from-stranger" }, { callerSessionId: stranger, host }));
            expect([foreign.ok, foreign.error?.code]).toEqual([false, "FORBIDDEN"]);

            // Stop by the great-grandparent is stored on the grandchild's run; a cancel by the grandparent says who cancelled it.
            const stopped = await update(top, w3.workflowSessionId, { operation: "stop", operation_id: "stop-w3", grace_seconds: 0 });
            expect(stopped.ok, JSON.stringify(stopped.error)).toBe(true);
            const w3Stop = (await read(top, w3.workflowSessionId)).run;
            expect(w3Stop.stop?.graceSeconds, JSON.stringify(w3Stop)).toBe(0);
            expect(w3Stop.lastControl).toMatchObject({ operation: "stop", by: "this session" });
            const cancelled = await update(top, w2.workflowSessionId, { operation: "cancel", operation_id: "cancel-w2" });
            expect(cancelled.ok, JSON.stringify(cancelled.error)).toBe(true);
            const w2Run = await h.store.readRun(w2.runId);
            expect(w2Run.status).toBe("cancelled");
            expect((await read(top, w2.workflowSessionId)).run.lastControl)
                .toMatchObject({ operation: "cancel", by: "this session", reason: "Cancelled by a session above it" });
            // Whole-PR review P-2: the default reason is chosen after the request is hashed, so the same cancel again is a replay.
            const again = await update(top, w2.workflowSessionId, { operation: "cancel", operation_id: "cancel-w2" });
            expect(again.ok, JSON.stringify(again.error)).toBe(true);
            expect(again.replayed).toBe(true);
            // The parent's own cancel keeps its words.
            const w1Cancel = await update(top, w1.workflowSessionId, { operation: "cancel", operation_id: "cancel-w1" });
            expect(w1Cancel.ok, JSON.stringify(w1Cancel.error)).toBe(true);
            expect((await read(top, w1.workflowSessionId)).run.lastControl).toMatchObject({ operation: "cancel", reason: "Cancelled by its parent" });
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

    // Owner decision 2026-11-26 (i2-trees = keep-code), pinned as built: owners compare exactly ("none" for every ownerless
    // session, "system" for a system session, the provider and subject of a user, the System user included).
    it("an all-unowned tree lets an ancestor read and cancel a nested Workflow; a system root is another owner below its direct child", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const read = async (caller, workflowId) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId }, { callerSessionId: caller, host }));
            const update = async (caller, workflowId, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args },
                { callerSessionId: caller, host }));
            const send = async (caller, workflowId, n) => JSON.parse(await sendWorkflowInputFromTool({ workflow_id: workflowId, contract: "Ping@1",
                payload: { n }, operation_id: `ping-${n}` }, { callerSessionId: caller, host }));
            const OTHER_OWNER = "This session belongs to another owner than the Workflow, so it may not read or control it.";

            // Unowned: top → W1 → W2, no session with an owner.
            const top = randomUUID();
            await h.catalog.createSession(top, {});
            const w1 = await workflowOf(h, top, null);
            const w2 = await workflowOf(h, w1.workflowSessionId, null);
            for (const id of [top, w1.workflowSessionId, w2.workflowSessionId]) expect((await h.catalog.getSession(id)).owner ?? null, id).toBeNull();
            const unownedRead = await read(top, w2.workflowSessionId);
            expect(unownedRead.ok, JSON.stringify(unownedRead.error)).toBe(true);
            // Typed input stays with the parent: top may send to W1 (its own), not to W2.
            const toChild = await send(top, w1.workflowSessionId, 1);
            expect(toChild.ok, JSON.stringify(toChild.error)).toBe(true);
            const toGrandchild = await send(top, w2.workflowSessionId, 2);
            expect([toGrandchild.ok, toGrandchild.error?.code]).toEqual([false, "FORBIDDEN"]);
            // Control: the unowned grandparent cancels W2.
            const cancelled = await update(top, w2.workflowSessionId, { operation: "cancel", operation_id: "cancel-unowned" });
            expect(cancelled.ok, JSON.stringify(cancelled.error)).toBe(true);
            expect((await h.store.readRun(w2.runId)).status).toBe("cancelled");
            // An ownerless session outside the tree is not above W1: refused.
            const outsider = randomUUID();
            await h.catalog.createSession(outsider, {});
            const outside = await read(outsider, w1.workflowSessionId);
            expect([outside.ok, outside.error?.code]).toEqual([false, "FORBIDDEN"]);
            expect(outside.error.message).toMatch(PARENT_RULE);

            // System: root (is_system) → its sub-agent → W3 → W4, owners as spawning gives them (the System user below the root).
            const root = randomUUID();
            await h.catalog.createSession(root, { isSystem: true });
            const spawnOwner = parent => resolveEffectiveSpawnOwner(id => h.catalog.getSession(id), parent);
            const system = await spawnOwner(root);
            expect(system).toMatchObject({ provider: "system", subject: "system" });
            const agent = randomUUID();
            await h.catalog.createSession(agent, { parentSessionId: root, owner: system });
            expect(await h.catalog.getSession(root)).toMatchObject({ isSystem: true });
            expect(await h.catalog.getSession(agent)).toMatchObject({ isSystem: false, owner: { provider: "system", subject: "system" } });
            const own = await workflowOf(h, root, await spawnOwner(root));
            const w3 = await workflowOf(h, agent, await spawnOwner(agent));
            const w4 = await workflowOf(h, w3.workflowSessionId, await spawnOwner(w3.workflowSessionId));
            // The root reads and controls the Workflow it started (the parent rule compares no owners) ...
            expect((await read(root, own.workflowSessionId)).ok).toBe(true);
            const rootPause = await update(root, own.workflowSessionId, { operation: "pause", operation_id: "pause-own" });
            expect(rootPause.ok, JSON.stringify(rootPause.error)).toBe(true);
            // ... but is another owner to the Workflows below its direct child, read and control alike.
            for (const workflow of [w3, w4]) {
                const refusedRead = await read(root, workflow.workflowSessionId);
                expect([refusedRead.ok, refusedRead.error?.code]).toEqual([false, "FORBIDDEN"]);
                expect(refusedRead.error.message).toBe(OTHER_OWNER);
                const refusedCancel = await update(root, workflow.workflowSessionId, { operation: "cancel", operation_id: `root-cancel-${workflow.runId}` });
                expect([refusedCancel.ok, refusedCancel.error?.code]).toEqual([false, "FORBIDDEN"]);
            }
            // The System-user sessions between them match one another: the sub-agent reads and controls W4 as its ancestor.
            expect((await read(agent, w4.workflowSessionId)).ok).toBe(true);
            const agentPause = await update(agent, w4.workflowSessionId, { operation: "pause", operation_id: "pause-by-system-agent" });
            expect(agentPause.ok, JSON.stringify(agentPause.error)).toBe(true);
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

    it("stored parent links that loop never make an agent step an ancestor (fail closed)", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const update = async (caller, workflowId, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args },
                { callerSessionId: caller, host }));
            const read = async (caller, workflowId) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId }, { callerSessionId: caller, host }));
            const top = randomUUID();
            await h.catalog.createSession(top, { owner: OWNER_A });
            const w = await workflowOf(h, top, OWNER_A, AGENT_YAML);
            const step = await agentStepOf(h, w, top, OWNER_A);
            expect((await read(step, w.workflowSessionId)).ok, "the step reads its Workflow").toBe(true);
            // Corrupt the links into a loop: top's parent is the step, so the Workflow's chain reads W → top → step → W.
            await h.q("UPDATE SCHEMA.sessions SET parent_session_id = $2 WHERE session_id = $1", [top, step]);
            const paused = await update(step, w.workflowSessionId, { operation: "pause", operation_id: "pause-by-step-in-loop" });
            expect([paused.ok, paused.error?.code], JSON.stringify(paused)).toEqual([false, "FORBIDDEN"]);
            const looped = await read(step, w.workflowSessionId);
            expect([looped.ok, looped.error?.code], "a looping lineage reads nothing either").toEqual([false, "FORBIDDEN"]);
            // The parent relation does not read the chain: the Workflow's own parent keeps it.
            expect((await update(top, w.workflowSessionId, { operation: "pause", operation_id: "pause-by-parent" })).ok).toBe(true);
        } finally {
            await h.stop();
        }
    });

    it("a test run is controlled by the parent only; an ancestor naming one is refused", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const update = async (caller, workflowId, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args },
                { callerSessionId: caller, host }));
            const top = randomUUID();
            await h.catalog.createSession(top, { owner: OWNER_A });
            const sub = randomUUID();
            await h.catalog.createSession(sub, { parentSessionId: top, owner: OWNER_A });
            const w = await workflowOf(h, sub, OWNER_A, RECEIVER_YAML, { draft: true });
            const testRunId = randomUUID();
            await h.store.startTest({
                workflowSessionId: w.workflowSessionId, expectedRevision: 1, definitionHash: w.compiled.yamlSha256, operationId: "test-1",
                requestSha256: "nested-access-test",
                start: { runId: testRunId, mode: "test", controllerInstanceId: workflowTestControllerInstanceId(testRunId), inputsText: "{}",
                    kvText: "{}", testAgentMode: "mocked", controllerVersion: WORKFLOW_CONTROLLER_VERSION, fixturesText: "[]" },
            });
            for (const operation of ["pause", "cancel", "recover"]) {
                const refused = await update(top, w.workflowSessionId, { operation, operation_id: `ancestor-${operation}`, run_id: testRunId });
                expect([refused.ok, refused.error?.code], `${operation}: ${JSON.stringify(refused)}`).toEqual([false, "FORBIDDEN"]);
                expect(refused.error.message).toMatch(/^Only the session that started this Workflow/);
            }
            // The parent controls the test run.
            const parentPause = await update(sub, w.workflowSessionId, { operation: "pause", operation_id: "parent-test-pause", run_id: testRunId });
            expect(parentPause.ok, JSON.stringify(parentPause.error)).toBe(true);
            expect(parentPause.runId).toBe(testRunId);
        } finally {
            await h.stop();
        }
    });

    it("child_workflows full read gives one moment of a child that ends during the read (review r2)", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const top = randomUUID();
            await h.catalog.createSession(top, { owner: OWNER_A });
            const parent = await workflowOf(h, top, OWNER_A);
            const child = await workflowOf(h, parent.workflowSessionId, OWNER_A);
            // The child ends right after the read's first look at its run, as a terminal write commits all its fields at once.
            let ended = false;
            const end = async () => {
                if (ended) return;
                ended = true;
                await h.q(`UPDATE SCHEMA.workflow_runs SET status = 'completed', terminal_outcome = 'succeeded', terminal_node_id = 'done',
                    terminal_output = '{"report":"final"}', finished_at = now() WHERE run_id = $1`, [child.runId]);
            };
            const store = new Proxy(h.store, {
                get(target, prop) {
                    const value = Reflect.get(target, prop, target);
                    if (typeof value !== "function") return value;
                    if (prop === "listRuns" || prop === "readLiveRunResult" || prop === "readRun") {
                        return async (...args) => { const result = await value.apply(target, args); await end(); return result; };
                    }
                    return value.bind(target);
                },
            });
            const host = { ...hostOf(h), store };
            const read = async () => JSON.parse(await childWorkflowsFromTool({ operation: "read", workflow_id: child.workflowSessionId, full_output: true },
                { callerWorkflowSessionId: parent.workflowSessionId, host }));
            const first = await read();
            expect(first.ok, JSON.stringify(first.error)).toBe(true);
            expect(ended, "the child ended during the read").toBe(true);
            const active = ["admitted", "running", "paused"].includes(first.run.status);
            // Either the moment before the end (active, no output) or the moment after (completed with its output), never a mix.
            expect({ status: first.run.status, outcome: first.run.outcome, output: first.run.output })
                .toEqual(active ? { status: first.run.status, outcome: null, output: null } : { status: "completed", outcome: "succeeded", output: '{"report":"final"}' });
            const second = await read();
            expect(second.run).toMatchObject({ runId: child.runId, status: "completed", outcome: "succeeded", terminalState: "done", output: '{"report":"final"}' });
        } finally {
            await h.stop();
        }
    });

    // Whole-PR review P-7: I2 makes a grandparent an ancestor for read_workflow and update_workflow; child_workflows stays
    // with the direct parent Workflow, so a grandchild is not found for read, stop and cancel.
    it("child_workflows does not reach a grandchild Workflow (read, stop and cancel)", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const top = randomUUID();
            await h.catalog.createSession(top, { owner: OWNER_A });
            const w1 = await workflowOf(h, top, OWNER_A);
            const w2 = await workflowOf(h, w1.workflowSessionId, OWNER_A);
            const w3 = await workflowOf(h, w2.workflowSessionId, OWNER_A);
            for (const args of [{ operation: "read" }, { operation: "read", full_output: true }, { operation: "stop", operation_id: "stop-grandchild" },
                { operation: "cancel", operation_id: "cancel-grandchild" }]) {
                const res = JSON.parse(await childWorkflowsFromTool({ ...args, workflow_id: w3.workflowSessionId },
                    { callerWorkflowSessionId: w1.workflowSessionId, host }));
                expect([res.ok, res.error?.code], JSON.stringify(args)).toEqual([false, "WORKFLOW_NOT_FOUND"]);
            }
            expect((await h.store.readRun(w3.runId)).status).not.toBe("cancelled");
            // Its own parent still reaches it.
            const own = JSON.parse(await childWorkflowsFromTool({ operation: "read", workflow_id: w3.workflowSessionId },
                { callerWorkflowSessionId: w2.workflowSessionId, host }));
            expect(own.ok, JSON.stringify(own.error)).toBe(true);
        } finally {
            await h.stop();
        }
    });

    // Whole-PR review P-7: the WorkflowEnded@1 limit at its edge, measured on the widest form a receive hands on.
    it("a WorkflowEnded@1 notice fits at exactly 195,584 bytes in its widest form, and not one byte more", () => {
        expect(WORKFLOW_ENDED_NOTICE_MAX_BYTES).toBe(256 * 1024 - 64 * 1024 - 1024);
        expect(WORKFLOW_ENDED_NOTICE_MAX_BYTES).toBe(195_584);
        const child = randomUUID();
        const payloadOf = filler => ({ workflowId: child, runId: "r", status: "completed", output: { text: filler }, outputTruncated: false });
        const widest = filler => utf8ByteLength(canonicalJson({ carry: null, result: { contract: "WorkflowEnded@1", from: child, payload: payloadOf(filler) } }));
        const base = widest("");
        const exact = "x".repeat(WORKFLOW_ENDED_NOTICE_MAX_BYTES - base);
        expect(widest(exact)).toBe(WORKFLOW_ENDED_NOTICE_MAX_BYTES);
        expect(workflowEndedNoticeFits(child, payloadOf(exact))).toBe(true);
        expect(workflowEndedNoticeFits(child, payloadOf(`${exact}x`))).toBe(false);
    });

    it("child_workflows needs both parent records, and reads a kept outcome only for a Workflow that is gone", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const child = async (callerWorkflowSessionId, args) => JSON.parse(await childWorkflowsFromTool(args, { callerWorkflowSessionId, host }));
            const top = randomUUID();
            await h.catalog.createSession(top, { owner: OWNER_A });
            const parentA = await workflowOf(h, top, OWNER_A);
            const parentB = await workflowOf(h, top, OWNER_A);
            // A child whose session row names parent A but whose definition names parent B (inconsistent records).
            const mixed = await workflowOf(h, parentA.workflowSessionId, OWNER_A);
            await h.q("UPDATE SCHEMA.workflow_definitions SET parent_session_id = $2 WHERE workflow_session_id = $1",
                [mixed.workflowSessionId, parentB.workflowSessionId]);
            await h.q(`UPDATE SCHEMA.workflow_runs SET status = 'completed', terminal_outcome = 'succeeded', terminal_node_id = 'done',
                terminal_output = '{"secret":"kept"}', finished_at = now() WHERE run_id = $1`, [mixed.runId]);
            // Retention keeps the outcome with the definition's parent (B).
            await h.q("SELECT SCHEMA.workflow_record_terminal_outcome($1)", [mixed.runId]);
            const good = await workflowOf(h, parentA.workflowSessionId, OWNER_A);

            const listed = await child(parentA.workflowSessionId, { operation: "list", status: "all" });
            expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
            expect(listed.children.map(item => item.workflowId)).toEqual([good.workflowSessionId]);
            expect((await child(parentB.workflowSessionId, { operation: "list", status: "all" })).children).toEqual([]);
            for (const [label, caller] of [["session parent", parentA], ["definition parent", parentB]]) {
                for (const args of [{ operation: "read", workflow_id: mixed.workflowSessionId },
                    { operation: "read", workflow_id: mixed.workflowSessionId, full_output: true }]) {
                    const refused = await child(caller.workflowSessionId, args);
                    expect([refused.ok, refused.error?.code], `${label} ${JSON.stringify(args)}: ${JSON.stringify(refused)}`)
                        .toEqual([false, "WORKFLOW_NOT_FOUND"]);
                }
            }
            expect((await child(parentA.workflowSessionId, { operation: "read", workflow_id: good.workflowSessionId })).ok).toBe(true);
        } finally {
            await h.stop();
        }
    });
});
