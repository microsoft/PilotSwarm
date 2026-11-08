/**
 * Workflows are always on (owner decision 2026-11-08T08:03Z; the stage 2.0 switch PILOTSWARM_WORKFLOWS is gone), on
 * PostgreSQL. Unit side: test/unit/workflows-always-on.test.mjs.
 *
 * - A management client made with no Workflow option, with PILOTSWARM_WORKFLOWS unset or set to the retired `off`: a
 *   person's input to a session in a Workflow agent node's subtree is refused (403 WORKFLOW_HUMAN_INPUT_DENIED), the access
 *   check reads the lineage, a v2 workflow's read works, and the bootstrap's answer is `enabled: true`.
 * - The client, likewise: a person's prompt to that session is refused, the setting unset or `off`.
 * - A real 1.0.83 turn of a worker whose session manager was made with no Workflow setting: the turn's bridge has no
 *   switch, and spawn_workflow, update_workflow, read_workflow and send_workflow_input reach the workflow code.
 * - With script nodes off, a definition with one is refused in words naming PILOTSWARM_WORKFLOW_SCRIPTS; one without is
 *   saved.
 * The model is scripted; no portal process runs here.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient, PilotSwarmClient } from "../helpers/local-workers.js";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { WORKFLOW_HUMAN_INPUT_DENIED } from "../../src/workflow/v2/input-policy.ts";
import { WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";
import { intakeNativeCase, INTAKE_NATIVE_TIMEOUT } from "../helpers/workflow-v2-intake-native-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflows-always-on-test" };

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

/** A published workflow of `parent` whose agent state is admitted pending with its child `childSessionId`. */
async function agentStateOf({ catalog, store }, parent, childSessionId, owner = null) {
    const compiled = compileWorkflowV2(AGENT_YAML, { enableRequests: true, enableAgents: true });
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner,
        creationConfig: { workflowV2: { requestSha256: "workflows-switch" } } })).toEqual({ created: true });
    await store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: AGENT_YAML, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "workflows-switch", publish: true, title: "Workflow: reviewer",
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

async function caught(call) {
    try { await call(); return null; } catch (error) { return error; }
}

/** Runs `fn` with PILOTSWARM_WORKFLOWS as given (undefined: unset), then puts it back. */
async function withWorkflowsEnv(value, fn) {
    const before = process.env.PILOTSWARM_WORKFLOWS;
    if (value === undefined) delete process.env.PILOTSWARM_WORKFLOWS;
    else process.env.PILOTSWARM_WORKFLOWS = value;
    try { return await fn(); } finally {
        if (before === undefined) delete process.env.PILOTSWARM_WORKFLOWS;
        else process.env.PILOTSWARM_WORKFLOWS = before;
    }
}

describe("Workflows always on: the management client and the client", () => {
    it("with no Workflow setting or the retired PILOTSWARM_WORKFLOWS=off: the lineage is read, a person's input refused, reads work", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        const on = await withWorkflowsEnv("off", () => createManagementClient(env));
        const client = new PilotSwarmClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
        await client.start();
        try {
            const owner = { provider: "test", subject: `switch-${randomUUID()}` };
            const P = randomUUID();
            await h.catalog.createSession(P, { owner });
            const C = randomUUID();
            const { workflowSessionId: W } = await agentStateOf(h, P, C, owner);
            await h.catalog.createSession(C, { parentSessionId: W, owner });
            const person = { kind: "user", provider: owner.provider, subject: owner.subject, display: "Owner", relation: "owner" };

            for (const retired of [undefined, "off"]) {
                await withWorkflowsEnv(retired, async () => {
                    // The agent node's chat is refused to a person; the access check reads its lineage; the read works.
                    expect((await caught(() => on.sendMessage(C, "do something else", { sender: person })))?.code).toBe(WORKFLOW_HUMAN_INPUT_DENIED);
                    expect(await on.getWorkflowInputPolicy(C)).toMatchObject({ canSendPrompt: false, workflowSessionId: W });
                    expect((await on.readWorkflow(W)).definition).toBeTruthy();
                    expect((await on.getWorkflowCapabilities()).enabled).toBe(true);
                    // The client: a person's prompt to the agent node's chat is refused too.
                    const session = await client.resumeSession(C);
                    expect((await caught(() => session.send("hello")))?.code).toBe(WORKFLOW_HUMAN_INPUT_DENIED);
                });
            }
        } finally {
            await client.stop();
            await on.stop();
            await h.stop();
        }
    });
});

describe("Workflows always on: a real 1.0.83 turn (runTurnV5)", () => {
    const V2_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: switch-probe, version: "1.0.0" }
initial: done
states:
  done: { type: terminal, outcome: succeeded }
`;
    {
        it("with a session manager made with no Workflow setting, the turn's workflow tools reach the workflow code", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
            const env = getEnv();
            const seen = [];
            // Each call's answer, or the words of what it threw (so the turn always finishes and the test reads why).
            const answer = async (call) => { try { return await call(); } catch (error) { return `threw: ${error?.message ?? error}`; } };
            const script = async (_call, _prompt, opts) => {
                const bridge = opts.controlToolBridge;
                const entry = { switched: Object.hasOwn(bridge ?? {}, "workflowsDisabled") };
                seen.push(entry);
                entry.spawn = await answer(() => bridge.spawnWorkflow({ yaml: V2_YAML }, { toolCallId: "call-spawn" }));
                entry.update = await answer(() => bridge.updateWorkflow({ workflow_id: randomUUID(), operation: "pause", operation_id: "op-1" }));
                entry.read = await answer(() => bridge.readWorkflow({ workflow_id: randomUUID() }));
                entry.send = await answer(() => bridge.sendWorkflowInput({ workflow_id: randomUUID(), input: {} }));
                entry.finished = true;
                return { type: "completed", content: "done", events: [] };
            };
            await intakeNativeCase(env, "workflows always on turn", script,
                { testOptions: { workflowRequests: true }, managerExtras: { workflowScriptsEnabled: true } }, async h => {
                    await h.start();
                    await h.until(({ history }) => history.some(event => event.kind === "QueueSubscribed"), "the session waits for its messages");
                    await h.say("probe the workflow tools", "cm-switch-1");
                    await h.until(() => seen[0]?.finished === true, "the turn calls each workflow tool");
                    expect(seen[0].switched, "the bridge has no Workflows switch").toBe(false);
                    for (const field of ["spawn", "update", "read", "send"]) expect(seen[0][field], field).not.toContain("WORKFLOWS_DISABLED");
                });
        });
    }
});

describe("Workflows always on, scripts off, on a real 1.0.83 turn", () => {
    const SCRIPT_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: scripted-probe, version: "1.0.0" }
initial: poll
states:
  poll: { type: script, runtime: node, source: "return { outcome: 'done' };", timeoutSeconds: 30, transition: { next: { done: finish } } }
  finish: { type: terminal, outcome: succeeded }
`;
    const WAIT_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: waiting-probe, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 5, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;
    it("spawn_workflow is offered; a definition with a script node is refused in words naming the setting, one without is saved", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const env = getEnv();
        const seen = [];
        const script = async (_call, _prompt, opts) => {
            const bridge = opts.controlToolBridge;
            const entry = { switched: Object.hasOwn(bridge ?? {}, "workflowsDisabled") };
            seen.push(entry);
            entry.draft = await bridge.spawnWorkflow({ yaml: SCRIPT_YAML, key: "scripted-draft" }, { toolCallId: "call-1" });
            entry.started = await bridge.spawnWorkflow({ yaml: SCRIPT_YAML, key: "scripted-start", state: "published", start: true, inputs: {} }, { toolCallId: "call-2" });
            entry.waits = await bridge.spawnWorkflow({ yaml: WAIT_YAML, key: "waits" }, { toolCallId: "call-3" });
            entry.finished = true;
            return { type: "completed", content: "done", events: [] };
        };
        // inlineClient: the turn's workflow host is made as on a worker (its client on the test's store), so the save without
        // a script node can be stored; the refused ones never reach it (the gate decides from the YAML first; the e02ec6f8
        // run answered WORKFLOW_ERROR because this case had no host and the gate came after it).
        await intakeNativeCase(env, "workflows on, scripts off", script,
            { testOptions: { workflowRequests: true }, inlineClient: true, managerExtras: { workflowScriptsEnabled: false } }, async h => {
                // The Workflow children under the chat other than the intake fixture's own (h.workflowSessionId, "Workflow: intake
                // activity tests", which the fixture makes right after the chat, before any turn, for its activity tests): it is
                // not the turn's, so it is left out by id, as in the first case above. Each row's id and title show in a failure.
                expect(h.workflowSessionId).toEqual(expect.any(String));
                const strayChildren = async () => (await h.catalog.pool.query(
                    `SELECT session_id, title FROM "${env.cmsSchema}".sessions
                      WHERE parent_session_id = $1 AND session_kind = 'workflow' AND session_id <> $2 ORDER BY session_id`,
                    [h.sessionId, h.workflowSessionId])).rows;
                const before = await strayChildren();
                expect(before, JSON.stringify(before)).toEqual([]);
                await h.start();
                await h.until(({ history }) => history.some(event => event.kind === "QueueSubscribed"), "the session waits for its messages");
                await h.say("probe the scripts gate", "cm-scripts-1");
                await h.until(() => seen[0]?.finished === true, "the turn calls spawn_workflow three times");
                expect(seen[0].switched).toBe(false);
                for (const [field, when] of [["draft", "saved"], ["started", "started"]]) {
                    const answer = JSON.parse(seen[0][field]);
                    expect(answer.ok, seen[0][field]).toBe(false);
                    expect(answer.error.code, seen[0][field]).toBe("WORKFLOW_SCRIPTS_DISABLED");
                    expect(answer.error.message, seen[0][field]).toContain("PILOTSWARM_WORKFLOW_SCRIPTS=1");
                    expect(answer.error.message.endsWith(`Nothing was ${when}.`), seen[0][field]).toBe(true);
                }
                expect(seen[0].waits).not.toContain("WORKFLOW_SCRIPTS_DISABLED");
                // Stage 2.1: spawn_workflow without start saves the chat's definition; nothing of the refused ones was saved.
                expect(JSON.parse(seen[0].waits), seen[0].waits).toMatchObject({ ok: true, operation: "save", name: "waiting-probe", revision: 1 });
                const definitions = await h.store.chat.listDefinitions(h.sessionId);
                expect(definitions.map(item => item.name)).toEqual(["waiting-probe"]);
                // A save without start creates no Workflow: none of the definition's, and no workflow child under the chat but the
                // fixture's own (the refused spawns created none either).
                const workflows = await h.store.chat.listWorkflows({ definitionId: definitions[0].definitionId });
                expect(workflows, JSON.stringify(workflows)).toEqual([]);
                const rows = await strayChildren();
                expect(rows, JSON.stringify(rows)).toEqual([]);
            });
    });
});
