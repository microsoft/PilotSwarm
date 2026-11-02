/**
 * Workflow v2 agent states: human input and depth in an agent state's
 * subtree (design 03 human-input denial and depth; R12 to R14, R16),
 * INACTIVE: only controller 1.9.0 creates agent states' children, and only
 * tests run it.
 *
 * - The store's lineage read: levels from the session rows (deleted rows
 *   included), the nearest agent state's child with its workflow and
 *   controlling agent, and no level for a cyclic or broken lineage.
 * - The SDK chokepoints every transport reaches (the portal and the TUI and
 *   MCP direct modes through the management client and the client session):
 *   a person's prompt, answer, steer, custom event, canvas write and
 *   workspace command to a session in an agent state's subtree are refused
 *   with 403 WORKFLOW_HUMAN_INPUT_DENIED before anything is queued; an
 *   agent-stamped one, and anything to an ordinary session, is not refused by
 *   this policy; getWorkflowInputPolicy reports it.
 * - A real 1.0.83 turn of a worker that runs agent states (runTurnV5 with
 *   the test-only switch): an agent state's child gets the completion bridge
 *   and the ask_user refusal flag and completes its state through the real
 *   tool path; a session outside every agent state gets neither. The session
 *   manager is given the flags it declares the model's tools from (every
 *   turn workflowMilestoneTurn; only an agent state's own child
 *   workflowAgentChild, which declares complete_workflow_node). The child
 *   of a real-agent test run's agent state also gets the test's tool
 *   interception (design 05 agent mode real): its framework tool call is
 *   recorded and answered by the test's fixture, and a call after its state
 *   was decided is refused; a live run's child does not get it.
 *
 * The model is scripted; no portal process runs here (the portal's access
 * response is web/test/workflow-input-runtime.test.mjs).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient, PilotSwarmClient } from "../helpers/local-workers.js";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { WORKFLOW_HUMAN_INPUT_DENIED } from "../../src/workflow/v2/input-policy.ts";
import { WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowLiveControllerInstanceId, workflowTestControllerInstanceId } from "../../src/workflow/v2/runtime.ts";
import { parseTestFixtures } from "../../src/workflow/v2/test-mode.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";
import { intakeNativeCase, INTAKE_NATIVE_TIMEOUT } from "../helpers/workflow-v2-intake-native-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-input-policy-test" };

const AGENT_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: reviewer, version: "1.0.0" }
initial: review
schemas:
  ReviewResult: { type: object, required: [verdict], properties: { verdict: { type: string } }, additionalProperties: false }
states:
  review:
    type: agent
    invoke: { prompt: "Review it." }
    outputSchema: { $ref: "#/schemas/ReviewResult" }
    timeoutSeconds: 3600
    transition: { next: { accepted: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

/**
 * A workflow of `parent` with an agent state admitted pending whose child is
 * `childSessionId` (its invocation record, as controller 1.9.0 admits one).
 */
async function agentStateOf({ catalog, store }, parent, childSessionId, owner = null) {
    const compiled = compileWorkflowV2(AGENT_YAML, { enableRequests: true, enableAgents: true });
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner,
        creationConfig: { workflowV2: { requestSha256: "input-policy" } } })).toEqual({ created: true });
    await store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: AGENT_YAML, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "input-policy", publish: true, title: "Workflow: reviewer",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
            inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION },
    });
    const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);
    expect(await store.enterNode({
        runId, nodeExecutionId, scopeId: "root", nodeId: "review", ordinal: 1, nodeType: "agent", predecessorId: null, arrivalRoute: null,
        inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
        agent: { childSessionId, controllingSessionId: parent, task: { source: "prompt", prompt: "Review it." }, outcomes: ["accepted"],
            outputSchema: "ReviewResult", timeoutSeconds: 3600 },
    })).toMatchObject({ admitted: true, inserted: true });
    return { workflowSessionId, runId, nodeExecutionId };
}

/**
 * A draft workflow of `parent` with a real-agent test run (agent mode real) whose agent state is admitted pending with its
 * child `childSessionId`, as controller 1.9.0 admits one; the test answers read_build { buildId: 7 } from a fixture.
 */
async function realTestAgentStateOf({ catalog, store }, parent, childSessionId) {
    const compiled = compileWorkflowV2(AGENT_YAML, { enableRequests: true, enableAgents: true });
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner: null,
        creationConfig: { workflowV2: { requestSha256: "input-policy-test" } } })).toEqual({ created: true });
    await store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: AGENT_YAML, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "input-policy-test", publish: false, start: null, title: "Workflow: reviewer",
    });
    const fixtures = parseTestFixtures([{ tool: "read_build", arguments: { buildId: 7 }, response: { kind: "success", value: { state: "green" } } }]);
    await store.startTest({
        workflowSessionId, expectedRevision: 1, definitionHash: compiled.yamlSha256, operationId: "test-1", requestSha256: "input-policy-test",
        start: { runId, mode: "test", controllerInstanceId: workflowTestControllerInstanceId(runId), inputsText: "{}", kvText: "{}",
            testAgentMode: "real", controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, fixturesText: canonicalJson(fixtures) },
    });
    const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);
    expect(await store.enterNode({
        runId, nodeExecutionId, scopeId: "root", nodeId: "review", ordinal: 1, nodeType: "agent", predecessorId: null, arrivalRoute: null,
        inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
        agent: { childSessionId, controllingSessionId: parent, task: { source: "prompt", prompt: "Review it." }, outcomes: ["accepted"],
            outputSchema: "ReviewResult", timeoutSeconds: 3600 },
    })).toMatchObject({ admitted: true, inserted: true });
    return { workflowSessionId, runId, nodeExecutionId };
}

async function denied(call, action) {
    let caught;
    try { await call(); } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(WORKFLOW_HUMAN_INPUT_DENIED);
    expect(caught?.status).toBe(403);
    expect(caught?.details?.action).toBe(action);
    return caught;
}

/** The call fails or succeeds for any reason but this policy. */
async function notDenied(call) {
    let caught = null;
    try { await call(); } catch (error) { caught = error; }
    expect(caught?.code ?? null, caught?.message).not.toBe(WORKFLOW_HUMAN_INPUT_DENIED);
}

describe("workflow v2 agent states: lineage and the human-input chokepoints", () => {
    it("reads a session's lineage from the stored rows: levels, the nearest agent state's child, deleted ancestors, broken chains", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const P = randomUUID();
            await h.catalog.createSession(P, {});
            const C = randomUUID();
            const { workflowSessionId: W, nodeExecutionId } = await agentStateOf(h, P, C);
            await h.catalog.createSession(C, { parentSessionId: W });
            const G = randomUUID();
            await h.catalog.createSession(G, { parentSessionId: C });
            const O = randomUUID();
            await h.catalog.createSession(O, { parentSessionId: P });
            const root = { childSessionId: C, nodeExecutionId, workflowSessionId: W, controllingSessionId: P };
            expect(await h.store.readWorkflowLineage(P)).toEqual({ sessionId: P, level: 0, agentRoot: null });
            expect(await h.store.readWorkflowLineage(W)).toEqual({ sessionId: W, level: 1, agentRoot: null });
            expect(await h.store.readWorkflowLineage(C)).toEqual({ sessionId: C, level: 2, agentRoot: { ...root, distance: 0 } });
            expect(await h.store.readWorkflowLineage(G)).toEqual({ sessionId: G, level: 3, agentRoot: { ...root, distance: 1 } });
            expect(await h.store.readWorkflowLineage(O)).toEqual({ sessionId: O, level: 1, agentRoot: null });
            expect(await h.store.readWorkflowLineage(randomUUID())).toBeNull();
            // A deleted ancestor still counts: its row is kept.
            await h.catalog.softDeleteSession(C);
            expect(await h.store.readWorkflowLineage(G)).toEqual({ sessionId: G, level: 3, agentRoot: { ...root, distance: 1 } });
            // A cycle or a missing parent has no level.
            const X = randomUUID();
            const Y = randomUUID();
            await h.catalog.createSession(X, {});
            await h.catalog.createSession(Y, { parentSessionId: X });
            await h.q("UPDATE SCHEMA.sessions SET parent_session_id = $2 WHERE session_id = $1", [X, Y]);
            expect(await h.store.readWorkflowLineage(X)).toEqual({ sessionId: X, level: null, agentRoot: null });
            const Z = randomUUID();
            await h.catalog.createSession(Z, {});
            await h.q("UPDATE SCHEMA.sessions SET parent_session_id = $2 WHERE session_id = $1", [Z, randomUUID()]);
            expect(await h.store.readWorkflowLineage(Z)).toEqual({ sessionId: Z, level: null, agentRoot: null });
        } finally {
            await h.stop();
        }
    });

    it("refuses a person's prompt, answer, steer, event, canvas write and workspace command to an agent state's subtree, at the SDK", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        const mgmt = await createManagementClient(env);
        const client = new PilotSwarmClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
        await client.start();
        try {
            const owner = { provider: "test", subject: `input-${randomUUID()}` };
            const P = randomUUID();
            await h.catalog.createSession(P, { owner });
            const C = randomUUID();
            const { workflowSessionId: W } = await agentStateOf(h, P, C, owner);
            await h.catalog.createSession(C, { parentSessionId: W, owner });
            const G = randomUUID();
            await h.catalog.createSession(G, { parentSessionId: C, owner });
            const O = randomUUID();
            await h.catalog.createSession(O, { parentSessionId: P, owner });
            const person = { kind: "user", provider: owner.provider, subject: owner.subject, display: "Owner", relation: "owner" };
            const agent = { kind: "agent", sessionId: P, display: "controlling parent agent" };
            const personPrincipal = { kind: "user", provider: owner.provider, subject: owner.subject, isAdmin: false };

            for (const target of [C, G]) {
                await denied(() => mgmt.sendMessage(target, "do something else", { sender: person }), "prompt");
                await denied(() => mgmt.sendMessage(target, "[canvas-action] {}", { sender: person }), "prompt");
                await denied(() => mgmt.sendAnswer(target, "yes", { sender: person }), "answer");
                await denied(() => mgmt.steerSessionTurn(target, { text: "go left", requestId: `steer-${target}`, caller: { sender: person } }), "steer");
                await denied(() => mgmt.writeCanvasKv(target, 1, personPrincipal, [{ op: "put", key: "app/x", value: 1 }]), "canvas");
                await denied(() => mgmt.setSessionWorkspace(target, { expectedRevision: 0, workspace: null }), "workspace");
                await denied(() => mgmt.retrySessionWorkspace(target), "workspace");
                const session = await client.resumeSession(target);
                await denied(() => session.send("hello"), "prompt");
                await denied(() => session.sendAndWait("hello", 1_000), "prompt");
                await denied(() => session.sendEvent("custom", { a: 1 }), "event");
                expect(await mgmt.getWorkflowInputPolicy(target)).toMatchObject({
                    canSendPrompt: false, canAnswer: false, canSteer: false, workflowSessionId: W, controllingSessionId: P });
            }
            // Nothing was queued or started for them.
            for (const target of [C, G]) expect((await client._getDuroxideClient().getStatus(`session-${target}`)).status).toBe("NotFound");
            // An agent-stamped message is not this policy's to refuse (it fails here only because no orchestration runs).
            await notDenied(() => mgmt.sendMessage(C, "focus on races", { sender: agent }));
            await notDenied(() => mgmt.steerSessionTurn(C, { text: "focus", requestId: "steer-agent", caller: { sender: agent } }));
            // An ordinary session keeps every path as before.
            await notDenied(() => mgmt.sendMessage(O, "hello", { sender: person }));
            await notDenied(() => mgmt.sendAnswer(O, "yes", { sender: person }));
            expect(await mgmt.getWorkflowInputPolicy(O)).toMatchObject({ canSendPrompt: true, canAnswer: true, canSteer: true, reason: null });
            expect(await mgmt.getWorkflowInputPolicy(P)).toMatchObject({ canSendPrompt: true });
        } finally {
            await client.stop();
            await mgmt.stop();
            await h.stop();
        }
    });
});

describe("workflow v2 agent states: a real 1.0.83 turn of a worker that runs them (runTurnV5, test-only switch)", () => {
    it("gives an agent state's child the completion bridge and the ask_user refusal flag, and completes its state through them", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const seen = [];
        const script = async (_call, _prompt, opts) => {
            const bridge = opts.controlToolBridge;
            seen.push({ subtree: bridge?.workflowAgentSubtree === true, complete: typeof bridge?.completeWorkflowNode === "function",
                milestone: bridge?.workflowMilestone === true, test: typeof bridge?.workflowTestToolCall === "function" });
            if (typeof bridge?.completeWorkflowNode === "function") {
                seen.at(-1).invalid = JSON.parse(await bridge.completeWorkflowNode({ outcome: "accepted", output: { verdict: 7 }, operation_id: "op-0" }));
                seen.at(-1).result = JSON.parse(await bridge.completeWorkflowNode({ outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-1" }));
            }
            // The completion commits before the call returns (it then wakes the controller), so the test waits for this mark,
            // not only for the stored state, before it reads what the calls returned.
            seen.at(-1).finished = true;
            return { type: "completed", content: "done", events: [] };
        };
        await intakeNativeCase(getEnv(), "agent state child turn", script, { testOptions: { workflowRequests: true } }, async h => {
            // The fixture's session becomes an agent state's child: a workflow of another parent admitted it.
            const P = randomUUID();
            await h.catalog.createSession(P, {});
            const { nodeExecutionId, runId } = await agentStateOf(h, P, h.sessionId);
            await h.start();
            await h.until(({ history }) => history.some(event => event.kind === "QueueSubscribed"), "the session waits for its messages");
            await h.say("start the review", "cm-agent-1");
            await h.until(async () => seen[0]?.finished === true && (await h.store.readNodeExecution(nodeExecutionId))?.state === "completed",
                "the turn completes the state");
            // A live run's child is not under a test: its tools are its own.
            expect(seen[0]).toMatchObject({ subtree: true, complete: true, milestone: true, test: false,
                invalid: { ok: false, error: { code: "OUTPUT_INVALID", attemptsLeft: 2 } },
                result: { ok: true, replayed: false, nodeExecutionId, runId, outcome: "accepted", kind: "result" } });
            expect(await h.store.readNodeExecution(nodeExecutionId)).toMatchObject({ outcome: "accepted", winner: "agent", output: { verdict: "ok" } });
            const turns = h.calls.filter(call => call.name === "runTurnV5" && call.input?.sessionId === h.sessionId);
            expect(turns.length).toBeGreaterThanOrEqual(1);
            // The model is declared its tools from the config each turn gives the session manager (session-manager.ts): a 1.9.0
            // turn's milestone tools and respond_session_request, and an agent state's own child's complete_workflow_node. The
            // bridge alone is invisible to the model; the first real-worker run had it without the declaration.
            expect(h.sessionConfigs.length).toBeGreaterThanOrEqual(1);
            for (const config of h.sessionConfigs) expect(config).toMatchObject({ workflowMilestoneTurn: true, workflowAgentChild: true });
        });
    });

    it("gives a real-agent test's child the test's tool interception: a fixture answers its framework call, and a call after its state was decided is refused", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const seen = [];
        const script = async (_call, _prompt, opts) => {
            const bridge = opts.controlToolBridge;
            const entry = { subtree: bridge?.workflowAgentSubtree === true, complete: typeof bridge?.completeWorkflowNode === "function",
                test: typeof bridge?.workflowTestToolCall === "function" };
            seen.push(entry);
            if (entry.test && entry.complete) {
                entry.answer = await bridge.workflowTestToolCall("read_build", { buildId: 7 });
                entry.result = JSON.parse(await bridge.completeWorkflowNode({ outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-1" }));
                try { await bridge.workflowTestToolCall("read_build", { buildId: 7 }); entry.after = "ran"; }
                catch (error) { entry.after = error?.code ?? String(error?.message ?? error); }
            }
            // As above: the state is stored before the calls return, so the test waits for the script to finish.
            entry.finished = true;
            return { type: "completed", content: "done", events: [] };
        };
        await intakeNativeCase(getEnv(), "real-agent test child turn", script, { testOptions: { workflowRequests: true } }, async h => {
            const P = randomUUID();
            await h.catalog.createSession(P, {});
            const { nodeExecutionId, runId } = await realTestAgentStateOf(h, P, h.sessionId);
            await h.start();
            await h.until(({ history }) => history.some(event => event.kind === "QueueSubscribed"), "the session waits for its messages");
            await h.say("start the review", "cm-real-agent-1");
            await h.until(async () => seen[0]?.finished === true && (await h.store.readNodeExecution(nodeExecutionId))?.state === "completed",
                "the turn completes the state");
            expect(seen[0]).toMatchObject({ subtree: true, complete: true, test: true, answer: { state: "green" },
                result: { ok: true, nodeExecutionId, runId, outcome: "accepted", kind: "result" }, after: "NODE_CLOSED" });
            expect(await h.store.readInterception(`${nodeExecutionId}/call-1`)).toMatchObject({ operation: "tool.call", tool: "read_build",
                state: "responded", response: { disposition: "fixture", value: { state: "green" } } });
            expect(await h.store.readInterception(`${nodeExecutionId}/call-2`)).toBeNull();
            expect(await h.store.readNodeExecution(nodeExecutionId)).toMatchObject({ outcome: "accepted", winner: "agent", output: { verdict: "ok" } });
            // A test run's agent state's own child is declared complete_workflow_node too (as above).
            expect(h.sessionConfigs.length).toBeGreaterThanOrEqual(1);
            for (const config of h.sessionConfigs) expect(config).toMatchObject({ workflowMilestoneTurn: true, workflowAgentChild: true });
        });
    });

    it("gives a session outside every agent state neither", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const seen = [];
        const script = async (_call, _prompt, opts) => {
            const bridge = opts.controlToolBridge;
            seen.push({ subtree: bridge?.workflowAgentSubtree === true, complete: typeof bridge?.completeWorkflowNode === "function",
                respond: typeof bridge?.respondSessionRequest === "function", milestone: bridge?.workflowMilestone === true,
                test: typeof bridge?.workflowTestToolCall === "function" });
            return { type: "completed", content: "done", events: [] };
        };
        await intakeNativeCase(getEnv(), "ordinary session turn", script, { testOptions: { workflowRequests: true } }, async h => {
            await h.start();
            await h.until(({ history }) => history.some(event => event.kind === "QueueSubscribed"), "the session waits for its messages");
            await h.say("hello", "cm-plain-1");
            await h.until(async () => seen.length >= 1, "the turn runs");
            // A turn of a worker that runs 1.9.0: its workflow tools describe and take the milestone (R26).
            expect(seen[0]).toEqual({ subtree: false, complete: false, respond: true, milestone: true, test: false });
            expect(canonicalJson(seen)).not.toContain("true,\"complete\":true");
            // Its turns are declared the milestone tools and respond_session_request, never complete_workflow_node.
            expect(h.sessionConfigs.length).toBeGreaterThanOrEqual(1);
            for (const config of h.sessionConfigs) {
                expect(config).toMatchObject({ workflowMilestoneTurn: true });
                expect(Object.hasOwn(config, "workflowAgentChild")).toBe(false);
            }
        });
    });
});
