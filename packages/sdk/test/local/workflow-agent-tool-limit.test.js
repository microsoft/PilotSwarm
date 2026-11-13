/**
 * Workflow Simplified stage 2.1c, FU-17, on PostgreSQL: an agent node's tool limit reaches the turn of its session.
 * - store.readAgentToolLimit reads the limit of a visit's state from its run's own revision: [] for `tools: none`, the
 *   names for a list, null for a state without a limit or a visit that does not exist;
 * - on a real 1.0.83 turn (runTurnV5) of the state's session, the config each turn gives the session manager carries the
 *   limit (workflowToolLimit), from which it offers the Copilot session only those tools (unit test
 *   workflow-agent-tool-limit.test.mjs); a session whose state sets no limit gets none.
 *
 * Run: npx vitest run test/local/workflow-agent-tool-limit.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { WORKFLOW_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { INTAKE_NATIVE_VARIANTS, INTAKE_NATIVE_TIMEOUT } from "../helpers/workflow-intake-native-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-agent-tool-limit-test" };

const yaml = tools => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: limited, version: "1.0.0" }
initial: review
states:
  review:
    type: agent
    invoke: { prompt: "Review it." }
    timeoutSeconds: 3600${tools === undefined ? "" : `\n    tools: ${tools}`}
    transition: { next: { accepted: hold, failure: failed } }
  hold: { type: wait, seconds: 60, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

/** A started workflow under `parent` whose agent state `review` admitted `childSessionId`, and that visit. */
async function agentStateOf({ catalog, store }, parent, childSessionId, tools) {
    const text = yaml(tools);
    const compiled = compileWorkflow(text);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner: null,
        creationConfig: { workflow: { requestSha256: "tool-limit" } } })).toEqual({ created: true });
    await store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: text, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "tool-limit", publish: true, title: "Workflow: limited",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
            inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION },
    });
    const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);
    expect(await store.enterNode({
        runId, nodeExecutionId, scopeId: "root", nodeId: "review", ordinal: 1, nodeType: "agent", predecessorId: null, arrivalRoute: null,
        inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
        agent: { childSessionId, controllingSessionId: parent, task: { source: "prompt", prompt: "Review it." }, outcomes: ["accepted"],
            outputSchema: null, timeoutSeconds: 3600 },
    })).toMatchObject({ admitted: true, inserted: true });
    return { workflowSessionId, runId, nodeExecutionId };
}

describe("FU-17: an agent node's tool limit (store)", () => {
    it("reads a visit's limit from its run's revision: none, a list, no limit, a visit that does not exist", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const parent = randomUUID();
            await h.catalog.createSession(parent, {});
            const none = await agentStateOf(h, parent, randomUUID(), "none");
            expect(await h.store.readAgentToolLimit(none.nodeExecutionId)).toEqual([]);
            const listed = await agentStateOf(h, parent, randomUUID(), "[read_facts, web_fetch]");
            expect(await h.store.readAgentToolLimit(listed.nodeExecutionId)).toEqual(["read_facts", "web_fetch"]);
            const open = await agentStateOf(h, parent, randomUUID(), undefined);
            expect(await h.store.readAgentToolLimit(open.nodeExecutionId)).toBeNull();
            expect(await h.store.readAgentToolLimit(nodeExecutionIdFor(randomUUID(), "root", "review", 1))).toBeNull();
        } finally {
            await h.stop();
        }
    });
});

describe.each(INTAKE_NATIVE_VARIANTS)("FU-17: an agent node's tool limit on a real $version turn ($turnName)", ({ intakeNativeCase }) => {
    for (const [label, tools, expected] of [["tools: none", "none", []], ["a list", "[read_facts]", ["read_facts"]], ["no limit", undefined, null]]) {
        it(`the session of a state with ${label} is given ${expected === null ? "no limit" : "that limit"} in each turn's config`, { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
            const seen = [];
            const script = async (_call, _prompt, opts) => {
                seen.push({ child: typeof opts.controlToolBridge?.completeWorkflowNode === "function" });
                return { type: "completed", content: "done", events: [] };
            };
            await intakeNativeCase(getEnv(), `tool limit ${label}`, script, {}, async h => {
                const P = randomUUID();
                await h.catalog.createSession(P, {});
                await agentStateOf(h, P, h.sessionId, tools);
                await h.start();
                await h.until(({ history }) => history.some(event => event.kind === "QueueSubscribed"), "the session waits for its messages");
                await h.say("start the review", `cm-limit-${randomUUID()}`);
                await h.until(async () => seen.length >= 1, "the turn runs");
                expect(seen[0].child).toBe(true);
                expect(h.sessionConfigs.length).toBeGreaterThanOrEqual(1);
                for (const config of h.sessionConfigs) {
                    expect(config).toMatchObject({ workflowAgentChild: true });
                    if (expected === null) expect(Object.hasOwn(config, "workflowToolLimit")).toBe(false);
                    else expect(config.workflowToolLimit).toEqual(expected);
                }
            });
        });
    }
});
