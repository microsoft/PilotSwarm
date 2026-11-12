/**
 * FB-008: a Start whose session's tool grant cannot be captured. Only script states call tools, through the grant captured
 * at Start. Before, workflow_definition start swallowed a failed capture (session-proxy.ts) and started the run with no
 * grant; its first script tool call then failed ("This workflow has no delegated tool grant; scripts in it cannot call
 * tools."), with nobody told at Start. spawn_workflow refused instead (WORKFLOW_PARENT_CONTEXT_UNAVAILABLE).
 *
 * - On a real worker (PostgreSQL, duroxide, the Copilot CLI, scripted model): a session with an in-memory application tool,
 *   which cannot be delegated durably (captureWorkflowToolBinding throws). Its Start of a revision with a script state is
 *   refused with the code and "Nothing was started", and no Workflow is made; its Start of a wait-only revision still starts
 *   and succeeds.
 * - On the store (no worker): the same two Starts with a capture that throws; the refused Start leaves nothing behind, so the
 *   same operation starts once the capture works. A repeat of a Start whose Workflow was stored is not given this refusal
 *   (its grant is only compared, as before; nothing new starts).
 *
 * Run: npx vitest run test/local/workflow-start-tool-grant.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { turnWorkflowsOn } from "../helpers/workflows-on.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { WORKFLOW_PARENT_CONTEXT_UNAVAILABLE, workflowParentContextUnavailable } from "../../src/workflow/tool-policy.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const OWNER = { provider: "test", subject: "workflow-start-tool-grant" };
const ENGINE = { kind: "system", name: "workflow-start-tool-grant-test" };
const CODE = WORKFLOW_PARENT_CONTEXT_UNAVAILABLE;

const SCRIPT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: poll-probe, version: "1.0.0" }
initial: probe
states:
  probe:
    type: script
    source: |
      await callTool("store_fact", { key: "fb-008/probe", value: { polled: true } });
      await setResult("success", { polled: true });
    transition: { next: { success: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
const WAIT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: hold, version: "1.0.0" }
initial: pause
states:
  pause: { type: wait, seconds: 1, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

async function until(check, label, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function refusal(promise) {
    try {
        const value = await promise;
        return { started: value };
    } catch (error) {
        return { error };
    }
}

describe("a Start whose session's tools cannot be handed to the Workflow (FB-008)", () => {
    it("on a real worker: a script revision is refused and nothing is started; a wait-only revision starts", { timeout: TIMEOUT }, async () => {
        const answers = {};
        const PROMPT = "Save and start the probe and the hold workflows.";
        const respond = (_body, position) => {
            if (!position.lastUserText.includes(PROMPT)) return { content: "ok" };
            const steps = [
                { name: "workflow_definition", args: { operation: "save", name: "poll-probe", yaml: SCRIPT_YAML } },
                { name: "workflow_definition", args: { operation: "start", name: "poll-probe" } },
                { name: "workflow_definition", args: { operation: "save", name: "hold", yaml: WAIT_YAML } },
                { name: "workflow_definition", args: { operation: "start", name: "hold" } },
            ];
            if (position.step > 0) answers[position.step - 1] = JSON.parse(position.toolResults[0]);
            if (position.step < steps.length) return { tools: [steps[position.step]] };
            return { content: "Done." };
        };
        await withScriptedModel(getEnv(), { respond, worker: { workflowScripts: { enabled: true } } }, async ({ client, qualifiedModel }) => {
            // An application tool given in memory to this session: it cannot be delegated durably to a Workflow, so the
            // session's tool grant cannot be captured (captureWorkflowToolBinding throws).
            const session = await client.createSession({ model: qualifiedModel, owner: OWNER, tools: [{
                name: "app_lookup", description: "An in-memory application tool.", parameters: { type: "object", properties: {} },
                handler: async () => "app-result",
            }] });
            await turnWorkflowsOn(client._catalog, session.sessionId);
            await session.send(PROMPT);
            await until(() => answers[3], "the hold start's answer");
            const store = client._catalog.workflowStore();
            const definitions = await store.sessionDefinitions.listDefinitions(session.sessionId);
            const probe = definitions.find(item => item.name === "poll-probe");
            const hold = definitions.find(item => item.name === "hold");
            expect(answers[0]).toMatchObject({ ok: true, operation: "save", revision: 1, valid: true });
            // The script revision: refused, in words the agent can relay; no Workflow of it exists.
            const probeRuns = await store.sessionDefinitions.listWorkflows({ definitionId: probe.definitionId });
            let started = "";
            if (answers[1]?.ok) {
                // What the old path did: the run started with no grant, and its script failed at its first tool call.
                const run = await until(async () => {
                    const [row] = await store.listRuns(answers[1].workflowId);
                    return row && ["completed", "failed", "cancelled", "stopped"].includes(row.status) ? row : null;
                }, "the started probe's end", 60_000).catch(() => null);
                const visits = run ? await store.listNodeExecutions(run.runId) : [];
                started = `. A Workflow was started and ended ${run?.status ?? "(no end seen)"}; its probe visit: `
                    + JSON.stringify(visits.filter(visit => visit.nodeId === "probe").map(visit => ({ outcome: visit.outcome, error: visit.error }))).slice(0, 600);
            }
            expect(answers[1], `the start of a script revision${started}`).toMatchObject({ ok: false, error: { code: CODE } });
            expect(answers[1].error.message).toBe("poll-probe was not started: this session's tools could not be handed to it, and its "
                + "script state (probe) can call tools only through them. Nothing was started. Call workflow_definition start again; "
                + "if it is refused again, tell the user.");
            expect(answers[1].error.details).toEqual({ scriptNodes: ["probe"] });
            expect(probeRuns).toEqual([]);
            // The wait-only revision calls no tool: it starts without the grant and succeeds.
            expect(answers[3]).toMatchObject({ ok: true, operation: "start", name: "hold", revision: 1 });
            const holdRuns = await store.sessionDefinitions.listWorkflows({ definitionId: hold.definitionId });
            expect(holdRuns.map(row => row.workflowSessionId)).toEqual([answers[3].workflowId]);
            const holdRun = await until(async () => {
                const [row] = await store.listRuns(answers[3].workflowId);
                return row?.status === "completed" ? row : null;
            }, "the hold Workflow's success", 60_000);
            expect(holdRun.terminalOutcome).toBe("succeeded");
            const children = (await client._catalog.listSessions()).filter(row => row.parentSessionId === session.sessionId && row.sessionKind === "workflow");
            expect(children.map(row => row.sessionId)).toEqual([answers[3].workflowId]);
        });
    });

    it("on the store: refused before anything is written, so the same operation starts once the capture works", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const dispatched = [];
            const host = {
                catalog: h.catalog, store: h.store,
                duroxideClient: {
                    startOrchestrationVersioned: async (instanceId) => { dispatched.push(instanceId); },
                    getStatus: async () => ({ status: "Running" }),
                    enqueueEvent: async () => {},
                },
            };
            const session = randomUUID();
            await h.catalog.createSession(session, { owner: OWNER });
            const save = async (name, yaml) => (await saveSessionWorkflowDefinition(host, { ownerSessionId: session, name, yaml, expected: null,
                actor: { kind: "session", sessionId: session }, operationId: `save-${randomUUID()}`, by: "session" })).receipt;
            const grant = { value: null };
            let captures = 0;
            const binding = async () => {
                captures += 1;
                if (grant.value === null) throw workflowParentContextUnavailable();
                return grant.value;
            };
            const start = (definitionId, operationId) => startSessionWorkflowDefinition(host, { ownerSessionId: session, definition: { definitionId },
                inputs: {}, actor: ENGINE, operationId, owner: OWNER, binding });
            const probe = await save("poll-probe", SCRIPT_YAML.replace("fb-008/probe", "fb-008/store"));
            const hold = await save("hold", WAIT_YAML);

            // A wait-only revision starts without the grant.
            const held = await start(hold.definitionId, "start-hold");
            expect(held).toMatchObject({ operation: "start", name: "hold", revision: 1, replayed: false });
            expect(dispatched).toHaveLength(1);

            // A script revision is refused, and nothing is written: no Workflow, no claim, no dispatch.
            const operationId = "start-probe";
            const first = await refusal(start(probe.definitionId, operationId));
            expect(first.error?.code, first.error?.message ?? JSON.stringify(first.started)).toBe(CODE);
            expect(first.error.message).toMatch(/^poll-probe was not started: .+ Nothing was started\. Call workflow_definition start again; /);
            expect(first.error.details).toEqual({ scriptNodes: ["probe"] });
            expect(await h.store.sessionDefinitions.listWorkflows({ definitionId: probe.definitionId })).toEqual([]);
            expect(dispatched).toHaveLength(1);

            // The same operation, once the capture works: it starts with that grant.
            grant.value = { policy: "node-parent-tools-v1", parentSessionId: session, owner: OWNER, config: {},
                capabilities: { revision: 0, selections: [] }, tools: [], sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fixture" };
            const second = await start(probe.definitionId, operationId);
            expect(second).toMatchObject({ operation: "start", name: "poll-probe", revision: 1, replayed: false });
            expect(dispatched).toHaveLength(2);
            const config = await h.catalog.getSessionCreationConfig(second.workflowId);
            expect(config.workflowToolBinding).toMatchObject({ policy: "node-parent-tools-v1", parentSessionId: session });

            // The same operation again with the capture failing: a stored Workflow's grant is only compared, never required
            // again, so this refusal is not given; nothing new starts and the stored grant is kept.
            grant.value = null;
            const before = captures;
            const replay = await refusal(start(probe.definitionId, operationId));
            expect(captures).toBe(before + 1);
            expect(replay.error?.code ?? null, replay.error?.message).not.toBe(CODE);
            expect((await h.catalog.getSessionCreationConfig(second.workflowId)).workflowToolBinding).toMatchObject({ parentSessionId: session });
            expect(dispatched).toHaveLength(2);
        } finally {
            await h.stop();
        }
    });
});
