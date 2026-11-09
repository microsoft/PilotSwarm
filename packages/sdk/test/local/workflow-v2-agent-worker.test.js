/**
 * Workflow v2 agent states on a real worker (INACTIVE: the test-only worker
 * option testOptions.workflowRequests; workflow/v2/milestone-worker.ts). A
 * full PilotSwarmWorker (PostgreSQL, Duroxide and the Copilot CLI) with the
 * model scripted (scripted-model.mjs), as the scripted-harness tests run.
 *
 * - The worker runs controller 1.9.0: a published workflow whose agent state
 *   names the worker's own deployment agent starts a live run, and the
 *   worker's agent host resolves that agent (the registry-backed resolver
 *   over the agent registry and the worker's agents) and creates the child
 *   through a client of the worker's store: under the workflow, owned as the
 *   workflow's owner, bound to that agent, at the durable intake's
 *   orchestration (1.0.83).
 * - The child's real turn gets the wrapper as its first prompt, the bound
 *   agent's prompt and complete_workflow_node; the model's completion
 *   decides the state (winner agent), the run completes with its output, and
 *   the controller ends the child (done, sent while it ran: it had continued
 *   as new at 1.0.83), which then completes.
 * - A publication's exact package revision (R18, T070): a workflow whose
 *   agent state names a registry package agent is published as a 1.9.0 host
 *   publishes it, pinning the package's revision (its content hash); the
 *   package is then republished, and the worker's active version is the new
 *   one. A live run of the publication binds its child to the pinned
 *   revision (`<packageId>@<sha256>`); the worker installs that revision for
 *   it, beside the active one, and the child's real turn runs the pinned
 *   revision's prompt and completes the state. A later publication (a
 *   published workflow is immutable, so a later workflow) pins the new
 *   revision, and its run's child runs that one; the first publication keeps
 *   its pin. Everyone else keeps the active version. The packages are
 *   synthetic fixtures published into this test's own registry (its schema
 *   and the worker's local artifact store), as the pinned-revision test
 *   publishes them.
 * - A publication's workflow interface (R09, R18; T011, T070, T071; design
 *   04 package-agent I/O export, 09 `interface: name@version`): the package
 *   agent declares interface review_change@1 (package format v5, schemas
 *   read from inside the package); a workflow whose agent state names it,
 *   with exactly its outcomes and output schema, is published as a 1.9.0
 *   host publishes it, and the pin holds the interface's name, version and
 *   digest with the exact package revision. The package is republished with
 *   review_change@2 (an input schema, another output schema, another
 *   outcome). What no longer matches is refused at publication
 *   (CONTRACT_MISMATCH: the old interface name, or the new name with the old
 *   contract) and stays a draft: no run, no child, no model turn. The first
 *   publication's live run keeps its pinned revision and contract: its
 *   child's wrapper carries exactly review_change@1's outcomes and output
 *   schema, the child runs the pinned revision's prompt, a completion under
 *   the new interface's outcome is refused (OUTPUT_INVALID) and one under the
 *   pinned contract decides the state. A later publication naming
 *   review_change@2 pins the new revision and digest; its child's wrapper
 *   carries @2's input, input schema, output schema and outcomes, a result
 *   that misses @2's output schema is refused, and one that matches it
 *   decides the state.
 *
 * Test double: the model (scripted). Not an activation: one worker serves
 * everything here, and nothing in a deployment sets the option; duroxide
 * cannot route orchestration items by version, so a deployment would need
 * every worker to serve 1.9.0 and 1.0.83.
 *
 * Diagnostics: each case waits boundary by boundary (the state entered, the
 * child spawned, its turn at the model, the state decided, the run ended, the
 * child ended). A boundary that is not reached prints one bounded evidence
 * record before the schemas are dropped: the run, its node executions, the
 * agent invocation, the child's row, orchestration and events, the histories
 * of the controller and the agent orchestration (their failed events first),
 * the workflow's events, every model request, the worker's trace tail and
 * the case's own records (the pinned case: the binding and the copies the
 * worker serves). The worker logs at warning level, so a retried activity's
 * warning shows.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { systemText } from "../helpers/scripted-model.mjs";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { FilesystemArtifactStore, publishAgentPackageDir } from "../../src/index.ts";
import { pinnedAgentPackageId } from "../../src/agent-package-pins.ts";
import { PgSessionCatalog } from "../../src/cms.ts";
import { DURABLE_SESSION_LATEST_VERSION } from "../../src/orchestration-version.ts";
import { pickAgentCopyByPackageIdForOwner, pickAgentCopyForOwner } from "../../src/session-manager.ts";
import { createWorkflowAgentResolver } from "../../src/workflow/v2/agent-resolver.ts";
import { createWorkflowV2, updateWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowAgentInstanceId } from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";

const TIMEOUT = 480_000;
/** Each boundary's own wait: together within TIMEOUT. */
const BOUNDARY_MS = 60_000;
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "agent-worker-owner", email: null, displayName: null };
const ACTOR = { kind: "system", name: "workflow-v2-agent-worker-test" };
const ENDED = ["completed", "failed", "cancelled", "stopped"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A value as bounded JSON: whole when short, otherwise its head and size. */
function bounded(value, limit = 1_500) {
    let text;
    try { text = JSON.stringify(value); } catch (error) { return { unserializable: String(error?.message ?? error) }; }
    if (text === undefined) return null;
    return text.length <= limit ? JSON.parse(text) : { truncated: true, chars: text.length, head: text.slice(0, limit) };
}

/** A read for the evidence: its value, or the error that kept it from being read. */
async function read(fn) {
    try { return await fn(); } catch (error) { return { readError: String(error?.message ?? error) }; }
}

/** An orchestration instance's status, version and history: failed events first, then the last events. */
async function instanceEvidence(duroxide, instanceId) {
    return read(async () => {
        const [status, info, executions] = await Promise.all([duroxide.getStatus(instanceId), duroxide.getInstanceInfo(instanceId).catch(() => null),
            duroxide.listExecutions(instanceId).catch(() => [])]);
        const history = [];
        for (const executionId of executions) history.push(...(await duroxide.readExecutionHistory(instanceId, executionId)).map(event => ({ executionId, ...event })));
        const summary = event => ({ executionId: event.executionId, kind: event.kind, data: bounded(event.data, 600) });
        return {
            status: bounded(status, 1_500), orchestrationVersion: info?.orchestrationVersion ?? null, executions: executions.length, events: history.length,
            failed: history.filter(event => /fail|error/i.test(String(event.kind))).slice(-12).map(summary),
            scheduled: history.filter(event => event.kind === "ActivityScheduled").map(event => /"name":"([^"]+)"/.exec(String(event.data))?.[1] ?? "?"),
            last: history.slice(-15).map(summary),
        };
    });
}

/** One agent state naming `agent` ({ name, package? }), then terminals. As a document (JSON is YAML). */
function workflowNaming(agent) {
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "worker-review", version: "1.0.0" },
        initialInput: { change: "rename a field" }, initial: "review",
        schemas: { Review: { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } }, additionalProperties: false } },
        states: {
            review: {
                type: "agent", invoke: { agent }, chat: "new", outputSchema: { $ref: "#/schemas/Review" }, timeoutSeconds: 600,
                transition: { next: { accepted: "done", failure: "failed" } },
            },
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    }, null, 2);
}

/** The first case's workflow: its agent state names the worker's deployment agent. */
const WORKFLOW = workflowNaming({ name: "workflow-reviewer" });

/**
 * The scripted model: the turn of an agent state's child (its request declares complete_workflow_node) completes the state at
 * once with `output`, then ends; every other request is answered "ok". Each child turn is recorded in `turns`.
 */
function completingModel(turns, output) {
    return (body, position) => {
        const tools = (body.tools ?? []).map(tool => tool.function?.name);
        if (!tools.includes("complete_workflow_node")) return { content: "ok" };
        if (position.step === 0) {
            turns.push({ prompt: position.lastUserText, system: systemText(body), tools });
            return { tools: [{ name: "complete_workflow_node", args: { outcome: "accepted", output, operation_id: "review-1" } }] };
        }
        turns.at(-1).result = position.toolResults.at(-1);
        return { content: "STATE_COMPLETED" };
    };
}

/**
 * The invocation an agent state's wrapper prompt carries (workflowAgentPrompt: its one line of runtime data, JSON that
 * parses to the exact value), or null.
 */
function invocationOf(prompt) {
    for (const line of String(prompt ?? "").split("\n")) {
        const text = line.trim();
        if (!text.startsWith("{")) continue;
        try {
            const value = JSON.parse(text);
            if (value && typeof value === "object" && typeof value.nodeExecutionId === "string") return value;
        } catch {
            // Not the invocation's line.
        }
    }
    return null;
}

/**
 * One agent state naming `agent` ({ name, package, interface }) under `contract` ({ inputSchema?, outputSchema,
 * outcomes }): its schemas declared once and referenced, an outcome route for each outcome, then terminals. As a
 * document (JSON is YAML).
 */
function contractedWorkflow(agent, contract) {
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "worker-contract-review", version: "1.0.0" },
        initialInput: { change: "rename a field" }, initial: "review",
        schemas: { ...(contract.inputSchema ? { ReviewInput: contract.inputSchema } : {}), ReviewResult: contract.outputSchema },
        states: {
            review: {
                type: "agent", invoke: { agent }, chat: "new", ...(contract.inputSchema ? { inputSchema: { $ref: "#/schemas/ReviewInput" } } : {}),
                outputSchema: { $ref: "#/schemas/ReviewResult" }, timeoutSeconds: 600,
                transition: { next: { ...Object.fromEntries(contract.outcomes.map(outcome => [outcome, "done"])), failure: "failed" } },
            },
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    }, null, 2);
}

/**
 * The scripted model of the interface case: an agent state's child reads the contract in its wrapper (the invocation's
 * outcomes) and first completes with the other interface revision's result, which the state's pinned contract refuses,
 * then with one that matches it, then ends its turn. review_change@1 takes { verdict } with accepted; @2 takes
 * { verdict, notes } with accepted or changes_required. Every other request is answered "ok". Each child turn is recorded
 * by its node execution, with its prompt, system prompt, invocation and each completion's answer. The answers depend on
 * the request alone, so a retried request gets the same one.
 */
function contractModel(turns) {
    return (body, position) => {
        const tools = (body.tools ?? []).map(tool => tool.function?.name);
        if (!tools.includes("complete_workflow_node")) return { content: "ok" };
        const invocation = invocationOf(position.lastUserText);
        const id = invocation?.nodeExecutionId ?? "unknown";
        const second = Array.isArray(invocation?.outcomes) && invocation.outcomes.includes("changes_required");
        const notes = "rename it everywhere";
        const wrong = second ? { outcome: "changes_required", output: { verdict: "rework" } }
            : { outcome: "changes_required", output: { verdict: "rework", notes } };
        const right = second ? { outcome: "changes_required", output: { verdict: "rework", notes } } : { outcome: "accepted", output: { verdict: "approved" } };
        if (position.step === 0) {
            const record = { id, prompt: position.lastUserText, system: systemText(body), tools, invocation, results: [] };
            const at = turns.findIndex(turn => turn.id === id);
            if (at >= 0) turns[at] = record;
            else turns.push(record);
            return { tools: [{ name: "complete_workflow_node", args: { ...wrong, operation_id: "contract-try" } }] };
        }
        const turn = turns.find(item => item.id === id);
        if (turn && position.step <= 2) turn.results[position.step - 1] = position.toolResults.at(-1);
        if (position.step === 1) return { tools: [{ name: "complete_workflow_node", args: { ...right, operation_id: "contract-final" } }] };
        return { content: "STATE_COMPLETED" };
    };
}

/** The worker's trace tail, for the evidence. */
function traceTail() {
    const traces = [];
    return { traces, traceWriter: line => { traces.push(String(line)); if (traces.length > 300) traces.shift(); } };
}

/**
 * The evidence and the boundary waits of one agent state's run (see the file's comment). `extra`, when given, reads the
 * case's own records into the evidence.
 */
function agentStateProbe({ store, catalog, duroxide, model, turns, traces, runId, nodeExecutionId, workflowSessionId, extra = null }) {
    /** Where the run stands: every durable record a boundary depends on. */
    const evidence = async () => {
        const run = await read(() => store.readRun(runId));
        const invocation = await read(() => store.readAgentInvocation(nodeExecutionId));
        const child = invocation && !invocation.readError ? invocation.childSessionId : null;
        const events = async sessionId => (await catalog.getSessionEvents(sessionId, 0, 300)).slice(-40)
            .map(event => ({ seq: event.seq, eventType: event.eventType, data: bounded(event.data, 300) }));
        return {
            run: bounded(run, 2_000),
            nodes: bounded(await read(async () => (await store.listNodeExecutions(runId)).map(node => ({
                nodeExecutionId: node.nodeExecutionId, nodeId: node.nodeId, state: node.state, outcome: node.outcome, winner: node.winner,
                resultKind: node.resultKind, output: node.output, error: node.error }))), 2_000),
            invocation: bounded(invocation, 2_000),
            child: child ? {
                row: bounded(await read(() => catalog.getSession(child)), 1_500),
                instance: await instanceEvidence(duroxide, `session-${child}`),
                events: bounded(await read(() => events(child)), 6_000),
            } : null,
            controller: run && !run.readError ? await instanceEvidence(duroxide, run.controllerInstanceId) : null,
            agentOrchestration: await instanceEvidence(duroxide, workflowAgentInstanceId(nodeExecutionId)),
            workflowEvents: bounded(await read(() => events(workflowSessionId)), 6_000),
            model: model.requests.map(request => {
                const tools = (request.body?.tools ?? []).map(tool => tool.function?.name).filter(Boolean);
                return {
                    index: request.index, session: request.session, turn: request.position.turn, step: request.position.step,
                    tools: tools.slice(0, 40), toolCount: tools.length, workflowTools: tools.filter(name => /workflow|session_request/.test(name)),
                    user: String(request.position.lastUserText ?? "").slice(0, 200),
                    toolResults: (request.position.toolResults ?? []).map(result => String(result).slice(0, 300)), answer: bounded(request.answer, 300),
                };
            }),
            turns: bounded(turns, 2_000),
            traces: traces.slice(-80),
            ...(extra ? { caseRecords: bounded(await read(extra), 4_000) } : {}),
        };
    };
    /** Wait for one boundary; one not reached prints the evidence once and fails naming it. */
    const boundary = async (label, check, timeoutMs = BOUNDARY_MS) => {
        const deadline = Date.now() + timeoutMs;
        let last = null;
        while (Date.now() < deadline) {
            last = await check();
            if (last) return last;
            await pause(250);
        }
        console.info("workflow agent worker evidence", JSON.stringify({ boundary: label, last: bounded(last, 500), ...(await evidence()) }));
        throw new Error(`boundary not reached: ${label} (the evidence record is printed above)`);
    };
    return { evidence, boundary };
}

/**
 * F-C2 and Q2: one agent state with an inline prompt and no route for a runtime error (as the deployment's
 * "subagent-check"), so a step whose child never completes fails the run timed_out at its deadline. As a document (JSON
 * is YAML).
 */
const proseWorkflow = (timeoutSeconds) => JSON.stringify({
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "prose-step", version: "1.0.0" }, initial: "summarize",
    states: {
        summarize: {
            type: "agent", invoke: { prompt: "Summarize the change in one line." }, chat: "new", outcomes: ["success"], timeoutSeconds,
            transition: { next: { success: "done" } },
        },
        done: { type: "terminal", outcome: "succeeded" },
    },
}, null, 2);
/** The start of the in-turn reminder the step's child gets (Q2, agent-reminder.ts). */
const REMINDER = "Reminder from the workflow: step 'summarize' is still open.";

/** Start a published prose-step workflow's live run under a new parent chat, as a 1.9.0 host's tools would. */
async function startProseStep(catalog, store, duroxide, timeoutSeconds) {
    const parent = randomUUID();
    await catalog.createSession(parent, { owner: OWNER });
    const workflowSessionId = randomUUID();
    const created = await createWorkflowV2({ catalog, store, duroxideClient: duroxide, requests: true }, {
        workflowSessionId, parentSessionId: parent, yaml: proseWorkflow(timeoutSeconds), actor: ACTOR, operationId: "create", publish: true,
        start: { inputs: {} }, notifyParent: false,
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    const runId = created.receipt.run.runId;
    return { parent, workflowSessionId, runId, nodeExecutionId: nodeExecutionIdFor(runId, "root", "summarize", 1) };
}

/** The step's reminders: recorded on the workflow (workflow.agent_reminded) and in the child's turns (runtime.workflow_step_reminded). */
async function reminders(catalog, workflowSessionId, child) {
    return {
        recorded: (await catalog.getSessionEvents(workflowSessionId, 0, 500, ["workflow.agent_reminded"])).map(event => event.data),
        inTurn: child ? (await catalog.getSessionEvents(child, 0, 500, ["runtime.workflow_step_reminded"])).map(event => event.data) : [],
    };
}

/** A session orchestration's published status, parsed. */
async function customStatusOf(duroxide, instanceId) {
    const status = await duroxide.getStatus(instanceId);
    const custom = status?.customStatus;
    try { return typeof custom === "string" ? JSON.parse(custom) : (custom ?? null); } catch { return null; }
}

describe("workflow v2 agent states on a real worker (test-only option, inactive)", () => {
    // F-C2 (the deployment at 65932bfc): a step whose model ends its turn in prose never completes; at the deadline the run
    // fails timed_out and the controller cancels the child. The end names the workflow as requestedBy, so the child takes it
    // as its parent's own cleanup: it records session.child_cleanup_completed on the workflow and sends it no CHILD_UPDATE
    // prompt. After the child's cancel, the workflow's row, the session list and a status read all still say failed, with
    // the run's error. (The deployment's race, a status read in the moment between the run's end and its controller's end,
    // is not forced here; failed-runtime-status.test.js covers that read with the controller still running.)
    // Q2 (owner decision, agent-reminder.ts): each turn that would end in prose with nothing pending gets one reminder
    // inside the turn, at most 3 per step. Here the parent's messages give the child four turns; the model ignores every
    // reminder, so the fourth turn finds them spent, and the run still ends timed_out at the step's deadline.
    it("F-C2: a step that never completes times out; after its child's cancel the workflow's row and the list still say failed, with its error", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        // The child's requests (they declare complete_workflow_node): an answer in prose, no completion. Others: "ok".
        const turns = [];
        const respond = (body, position) => {
            const tools = (body.tools ?? []).map(tool => tool.function?.name);
            if (!tools.includes("complete_workflow_node")) return { content: "ok" };
            turns.push({ prompt: position.lastUserText, step: position.step });
            return { content: "I looked at the change; it seems fine." };
        };
        const { traces, traceWriter } = traceTail();
        const worker = { logLevel: "warning", traceWriter };
        await withScriptedModel(env, { respond, worker }, async ({ client, model }) => {
            const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await catalog.initialize();
            const duroxide = client._getDuroxideClient();
            try {
                const store = catalog.workflowStore();
                // 90 s: room for four turns of the child before the deadline.
                const { parent, workflowSessionId, runId, nodeExecutionId } = await startProseStep(catalog, store, duroxide, 90);
                const { boundary } = agentStateProbe({ store, catalog, duroxide, model, turns, traces, runId, nodeExecutionId, workflowSessionId });

                await boundary("the child's turn reaches the model and ends in prose", async () => (turns.length > 0 ? turns[0] : null));
                const child = (await store.readAgentInvocation(nodeExecutionId)).childSessionId;
                // Each turn: one reminder inside it, then the child idles. The parent's message starts the next turn.
                for (let turn = 1; turn <= 4; turn += 1) {
                    if (turn > 1) {
                        await duroxide.enqueueEvent(`session-${child}`, "messages", JSON.stringify({
                            prompt: `Any news on the summary? (${turn})`, sender: { kind: "agent", sessionId: parent, display: "parent" },
                            clientMessageIds: [`parent-nudge-${turn}`],
                        }));
                    }
                    const expected = Math.min(turn, 3);
                    await boundary(`turn ${turn} is reminded (or finds the reminders spent) and ends`, async () => {
                        const seen = await reminders(catalog, workflowSessionId, child);
                        const idle = (await customStatusOf(duroxide, `session-${child}`))?.status === "idle";
                        const reached = turn === 1 || turns.some(item => item.prompt.includes(`(${turn})`));
                        return reached && seen.recorded.length === expected && idle ? true : null;
                    });
                }
                const seen = await reminders(catalog, workflowSessionId, child);
                expect(seen.recorded.map(data => data.n)).toEqual([1, 2, 3]);
                expect(new Set(seen.recorded.map(data => data.turn)).size).toBe(3);
                expect(seen.inTurn.map(data => [data.stateId, data.n, data.max])).toEqual([["summarize", 1, 3], ["summarize", 2, 3], ["summarize", 3, 3]]);
                // The model got each reminder once, as the last prompt of a turn's corrective run; the fourth turn got none.
                expect(turns.filter(item => item.prompt.includes(REMINDER))).toHaveLength(3);
                expect(turns.filter(item => item.prompt.includes("(4)"))).toHaveLength(1);

                const run = await boundary("the run ends", async () => {
                    const row = await store.readRun(runId);
                    return row && ENDED.includes(row.status) ? row : null;
                }, 150_000);
                expect(run).toMatchObject({ status: "failed", controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION });
                expect(await store.readNodeExecution(nodeExecutionId)).toMatchObject({ outcome: "timed_out", winner: "controller" });
                const invocation = await boundary("the child's end is sent", async () => {
                    const row = await store.readAgentInvocation(nodeExecutionId);
                    return row?.endSentAt ? row : null;
                });
                expect(invocation.endRequested).toBe("cancel");

                // The child takes the end as its parent's cleanup: recorded on the workflow, with the end's id and requestedBy.
                const cleanup = await boundary("the child records its cleanup on the workflow", async () =>
                    (await catalog.getSessionEvents(workflowSessionId, 0, 500, ["session.child_cleanup_completed"]))
                        .find(event => event.data?.childSessionId === child) ?? null);
                expect(cleanup.data).toMatchObject({ childSessionId: child, commandId: `workflow-agent-end:${nodeExecutionId}`,
                    requestedBy: workflowSessionId, status: "cancelled" });
                await boundary("the child's cancel completes", async () => ((await catalog.getSession(child))?.state === "cancelled" ? true : null));
                await boundary("the controller ends", async () =>
                    (["Completed", "Failed"].includes((await duroxide.getStatus(run.controllerInstanceId))?.status) ? true : null));

                // The workflow's row: failed, with the run's error.
                const row = await catalog.getSession(workflowSessionId);
                expect(row).toMatchObject({ sessionKind: "workflow", state: "failed" });
                expect(String(row.lastError ?? "")).toContain("timed_out");
                // The session list reads the rows: failed there too.
                expect((await catalog.listSessions()).find(item => item.sessionId === workflowSessionId)).toMatchObject({ state: "failed" });
                // A status read now (what a sendToSession to the workflow runs) says failed and leaves the row as it is.
                expect((await client._getSessionInfo(workflowSessionId)).status).toBe("failed");
                const after = await catalog.getSession(workflowSessionId);
                expect(after.state).toBe("failed");
                expect(after.lastError).toBe(row.lastError);
            } finally {
                await catalog.close();
            }
        });
    });

    it("Q2: a step that answers in prose is reminded inside its turn, then completes: the run succeeds before its deadline", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        // The child's first answer: prose. On the reminder (the same turn's corrective run): complete the state, then end. Others: "ok".
        const turns = [];
        const respond = (body, position) => {
            const tools = (body.tools ?? []).map(tool => tool.function?.name);
            if (!tools.includes("complete_workflow_node")) return { content: "ok" };
            turns.push({ prompt: position.lastUserText, step: position.step, turn: position.turn });
            if (!position.lastUserText.includes(REMINDER)) return { content: "Hello means a greeting." };
            if (position.step === 0) {
                return { tools: [{ name: "complete_workflow_node", args: { outcome: "success", output: { summary: "a greeting" }, operation_id: "after-reminder" } }] };
            }
            return { content: "STATE_COMPLETED" };
        };
        const { traces, traceWriter } = traceTail();
        const worker = { logLevel: "warning", traceWriter };
        await withScriptedModel(env, { respond, worker }, async ({ client, model }) => {
            const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await catalog.initialize();
            const duroxide = client._getDuroxideClient();
            try {
                const store = catalog.workflowStore();
                const { workflowSessionId, runId, nodeExecutionId } = await startProseStep(catalog, store, duroxide, 300);
                const { boundary } = agentStateProbe({ store, catalog, duroxide, model, turns, traces, runId, nodeExecutionId, workflowSessionId });

                await boundary("the child is reminded", async () => turns.find(turn => turn.prompt.includes(REMINDER)) ?? null);
                const run = await boundary("the run ends", async () => {
                    const row = await store.readRun(runId);
                    return row && ENDED.includes(row.status) ? row : null;
                });
                expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                expect(await store.readNodeExecution(nodeExecutionId)).toMatchObject({ outcome: "success", winner: "agent", output: { summary: "a greeting" } });
                const child = (await store.readAgentInvocation(nodeExecutionId)).childSessionId;
                const seen = await reminders(catalog, workflowSessionId, child);
                expect(seen.recorded).toEqual([expect.objectContaining({ nodeExecutionId, stateId: "summarize", childSessionId: child, n: 1, max: 3 })]);
                // The child's transcript shows the reminder as the runtime's correction inside its turn, not as a message.
                expect(seen.inTurn).toEqual([{ stateId: "summarize", n: 1, max: 3, sessionId: child }]);
                expect((await catalog.getSessionEvents(child, 0, 500, ["user.message"]))
                    .filter(event => String(event.data?.content ?? "").includes(REMINDER))).toEqual([]);
                // One turn: the first answer, then the reminder's run (its completion and its end), all in the same conversation turn.
                expect(turns.map(turn => [turn.prompt.includes(REMINDER), turn.step])).toEqual([[false, 0], [true, 0], [true, 1]]);
            } finally {
                await catalog.close();
            }
        });
    });

    // Q2: a schedule is pending work. The first turn sets a cron (15 s) and ends in prose: its own queued set is pending.
    // The cron's turn ends in prose too: the session's published status says the schedule is active (the activity's gate).
    // Neither is reminded.
    it("Q2: a turn that sets a cron, and the cron's own turn, get no reminder", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const turns = [];
        const respond = (body, position) => {
            const tools = (body.tools ?? []).map(tool => tool.function?.name);
            if (!tools.includes("complete_workflow_node")) return { content: "ok" };
            turns.push({ prompt: position.lastUserText, step: position.step });
            if (turns.length === 1) return { tools: [{ name: "cron", args: { seconds: 15, reason: "Check the change again." } }] };
            return { content: "Still checking; the schedule wakes me." };
        };
        const { traces, traceWriter } = traceTail();
        const worker = { logLevel: "warning", traceWriter };
        await withScriptedModel(env, { respond, worker }, async ({ client, model }) => {
            const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await catalog.initialize();
            const duroxide = client._getDuroxideClient();
            try {
                const store = catalog.workflowStore();
                const { workflowSessionId, runId, nodeExecutionId } = await startProseStep(catalog, store, duroxide, 300);
                const { boundary } = agentStateProbe({ store, catalog, duroxide, model, turns, traces, runId, nodeExecutionId, workflowSessionId });
                const child = (await boundary("the step's invocation is recorded", async () => store.readAgentInvocation(nodeExecutionId))).childSessionId;

                // The first turn is handled: the child waits on its cron.
                const armed = await boundary("the first turn's cron is set", async () => {
                    const status = await customStatusOf(duroxide, `session-${child}`);
                    return status?.cronActive === true && status.status === "waiting" ? status : null;
                });
                expect(armed).toMatchObject({ cronKind: "interval", cronInterval: 15 });
                expect(await reminders(catalog, workflowSessionId, child)).toEqual({ recorded: [], inTurn: [] });
                // The cron's turn reaches the model, ends in prose and is handled.
                await boundary("the cron's turn reaches the model", async () => (turns.length >= 3 ? true : null), 90_000);
                await boundary("the cron's turn is handled", async () => ((await customStatusOf(duroxide, `session-${child}`))?.status === "waiting" ? true : null));
                expect(await reminders(catalog, workflowSessionId, child)).toEqual({ recorded: [], inTurn: [] });
                expect(turns.filter(turn => turn.prompt.includes(REMINDER))).toEqual([]);
                expect((await store.readNodeExecution(nodeExecutionId)).state).toBe("pending");
            } finally {
                await catalog.close();
            }
        });
    });

    it("runs an agent state's child through the worker's own agent host: resolved, created, bound, at 1.0.83, completing its state", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const pluginDir = join(env.baseDir, `agent-worker-plugin-${env.runId}`);
        mkdirSync(join(pluginDir, "agents"), { recursive: true });
        writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "wfv2-agents", version: "1.0.0" }));
        writeFileSync(join(pluginDir, "agents", "workflow-reviewer.agent.md"),
            "---\nname: workflow-reviewer\ndescription: Reviews a change for a workflow.\n---\nWORKFLOW-REVIEWER-MARKER: review the change you are given.\n");
        // The child's turn: complete the state at once, then end the turn. Any other session answers "ok".
        const turns = [];
        const respond = completingModel(turns, { verdict: "approved" });
        const { traces, traceWriter } = traceTail();
        const worker = { pluginDirs: [pluginDir], logLevel: "warning", traceWriter };
        await withScriptedModel(env, { respond, worker }, async ({ client, model }) => {
            const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await catalog.initialize();
            const duroxide = client._getDuroxideClient();
            try {
                const store = catalog.workflowStore();
                const parent = randomUUID();
                await catalog.createSession(parent, { owner: OWNER });
                const workflowSessionId = randomUUID();
                // Published and started as a 1.9.0 host's tools would (the worker's controller runs it).
                const created = await createWorkflowV2({ catalog, store, duroxideClient: duroxide, requests: true }, {
                    workflowSessionId, parentSessionId: parent, yaml: WORKFLOW, actor: ACTOR, operationId: "create", publish: true,
                    start: { inputs: {} }, notifyParent: false,
                });
                expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
                const runId = created.receipt.run.runId;
                const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);
                const { boundary } = agentStateProbe({ store, catalog, duroxide, model, turns, traces, runId, nodeExecutionId, workflowSessionId });

                await boundary("the agent state is entered", () => store.readNodeExecution(nodeExecutionId));
                await boundary("the child is spawned", async () => (await store.readAgentInvocation(nodeExecutionId))?.spawnedAt ?? null);
                await boundary("the child's turn reaches the model with complete_workflow_node", async () => (turns.length > 0 ? turns[0] : null));
                await boundary("the state is decided", async () => {
                    const node = await store.readNodeExecution(nodeExecutionId);
                    return node?.state === "completed" ? node : null;
                });
                const run = await boundary("the run ends", async () => {
                    const row = await store.readRun(runId);
                    return row && ENDED.includes(row.status) ? row : null;
                });
                expect(run).toMatchObject({ status: "completed", controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, terminalOutput: { verdict: "approved" } });
                expect(await store.readNodeExecution(nodeExecutionId)).toMatchObject({ outcome: "accepted", winner: "agent", output: { verdict: "approved" } });
                const invocation = await store.readAgentInvocation(nodeExecutionId);
                expect(invocation).toMatchObject({ workflowSessionId, controllingSessionId: parent,
                    task: { source: "agent", name: "workflow-reviewer", package: null, version: null } });
                expect(invocation.spawnedAt).not.toBeNull();
                const child = invocation.childSessionId;

                // The child: under the workflow, owned as its owner, bound to the worker's deployment agent, at 1.0.83.
                expect(await catalog.getSession(child)).toMatchObject({ parentSessionId: workflowSessionId, agentId: "workflow-reviewer",
                    owner: { provider: OWNER.provider, subject: OWNER.subject } });
                expect(await sessionOrchestrationVersion(client, child)).toBe(DURABLE_SESSION_LATEST_VERSION);
                // Its real turn: the wrapper first, the bound agent's prompt, the completion tool; the completion was accepted.
                expect(turns[0].prompt).toContain("WORKFLOW NODE INVOCATION");
                expect(turns[0].prompt).toContain("Apply your role (agent workflow-reviewer) to the input above.");
                expect(turns[0].system).toContain("WORKFLOW-REVIEWER-MARKER");
                expect(JSON.parse(turns[0].result)).toMatchObject({ ok: true, kind: "result", outcome: "accepted", nodeExecutionId, runId });

                // After the agent's own completion the controller ends the child: done, handed to its queue while it ran (it had
                // continued as new at 1.0.83, not failed), and the child completes.
                const ended = await boundary("the child's end is sent", async () => {
                    const row = await store.readAgentInvocation(nodeExecutionId);
                    return row?.endSentAt ? row : null;
                });
                expect(ended.endRequested).toBe("done");
                expect(ended.endChildStatus).not.toMatch(/fail|terminat|notfound/i);
                await boundary("the child completes", async () => ((await duroxide.getStatus(`session-${child}`))?.status === "Completed" ? true : null));
                expect(await sessionOrchestrationVersion(client, child)).toBe(DURABLE_SESSION_LATEST_VERSION);
            } finally {
                await catalog.close();
            }
        });
    });

    it("runs an agent state's child at the package revision its publication pinned after a republish, and a later publication's child at the new one (R18, T070)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const tag = randomUUID().slice(0, 8);
        const kit = `pinned-review-kit-${tag}`;
        const reviewer = `pinned-reviewer-${tag}`;
        const marker = version => `PINNED-REVIEWER-${tag}-${version}`;
        /** One version of the registry package: its agent's prompt names the version. */
        const writeVersion = version => {
            const dir = join(env.baseDir, `agent-worker-kit-${tag}-${version}`);
            mkdirSync(join(dir, "agents"), { recursive: true });
            writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: kit, version, description: "A workflow's reviewer, one version at a time." }));
            writeFileSync(join(dir, "agents", `${reviewer}.agent.md`), [
                "---", `name: ${reviewer}`, "description: Reviews a change for a workflow.", "schemaVersion: 1", `version: ${version}`, "---",
                "", `${marker(version)}: review the change you are given.`, "",
            ].join("\n"));
            return dir;
        };
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        // Published as the portal and tools publish: into the worker's own artifact store (local mode), read by its installs.
        const registry = { catalog, artifactStore: new FilesystemArtifactStore(join(dirname(env.sessionStateDir), "artifacts")) };
        const publishVersion = version => publishAgentPackageDir(registry, {
            dir: writeVersion(version), scope: "shared", owner: OWNER, createdBy: "workflow-v2-agent-worker-test", isAdmin: false,
        });
        const turns = [];
        /** The child turn of one agent state: its wrapper prompt names the state's node execution. */
        const turnOf = stateExecutionId => turns.find(turn => String(turn.prompt ?? "").includes(stateExecutionId));
        const { traces, traceWriter } = traceTail();
        const worker = {
            workerPool: "default", logLevel: "warning", traceWriter,
            agentPackages: { cacheDir: join(env.baseDir, `agent-worker-packages-${tag}`), refreshIntervalMs: 0 },
        };
        try {
            // 1.0.0 is the active version when the worker starts.
            const v1 = await publishVersion("1.0.0");
            const pinnedId = pinnedAgentPackageId(v1.packageId, v1.sha256);
            await withScriptedModel(env, { respond: completingModel(turns, { verdict: "pinned" }), worker }, async ({ client, model, worker: running }) => {
                const duroxide = client._getDuroxideClient();
                const store = catalog.workflowStore();
                const copies = () => running.sessionManager.workerDefaults.agentPromptLookup[reviewer];
                const versionOf = copy => (!copy ? null : copy.prompt.includes(marker("1.0.0")) ? "1.0.0" : copy.prompt.includes(marker("1.1.0")) ? "1.1.0" : "other");
                const parent = randomUUID();
                await catalog.createSession(parent, { owner: OWNER });
                const workflowSessionId = randomUUID();
                // Published as a 1.9.0 host publishes (a worker's turn, the management client): the named agent is pinned from the
                // agent registry at the exact revision its owner sees.
                const host = { catalog, store, duroxideClient: duroxide, requests: true, resolveAgent: createWorkflowAgentResolver({ catalog }) };
                const created = await createWorkflowV2(host, {
                    workflowSessionId, parentSessionId: parent, yaml: workflowNaming({ name: reviewer }), actor: ACTOR, operationId: "create",
                    publish: true, notifyParent: false,
                });
                expect(created.receipt, JSON.stringify(created.receipt.diagnostics)).toMatchObject({ valid: true, state: "published", run: null });
                const pin = { name: reviewer, package: kit, version: "1.0.0", packageId: v1.packageId, revision: v1.sha256 };
                expect((await store.readDefinition(workflowSessionId)).publishedAgentPins).toEqual({ review: pin });

                // The package is republished: 1.1.0 is the registry's and this worker's active version, and the pinned revision is
                // not served yet. The publication keeps its pin.
                const v11 = await publishVersion("1.1.0");
                expect(v11.packageId).toBe(v1.packageId);
                expect(v11.sha256).not.toBe(v1.sha256);
                await running.refreshAgentPackages();
                expect(versionOf(pickAgentCopyForOwner(copies(), null))).toBe("1.1.0");
                expect(pickAgentCopyByPackageIdForOwner(copies(), pinnedId, null)).toBeUndefined();
                expect((await store.readDefinition(workflowSessionId)).publishedAgentPins).toEqual({ review: pin });

                // A live run of the publication.
                const started = await updateWorkflowV2(host, workflowSessionId, { operation: "start", definitionHash: created.receipt.yamlSha256, inputs: {} },
                    { actor: ACTOR, operationId: "start" });
                const runId = started.receipt.run.runId;
                const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);
                /** The case's own records for the evidence: the state's task, its child's binding and what the worker serves. */
                const bindingOf = (stateExecutionId, ids) => async () => {
                    const invocation = await store.readAgentInvocation(stateExecutionId);
                    return {
                        ids, task: invocation?.task ?? null,
                        creationConfig: invocation ? await catalog.getSessionCreationConfig(invocation.childSessionId) : null,
                        served: { active: versionOf(pickAgentCopyForOwner(copies(), null)),
                            ...Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, versionOf(pickAgentCopyByPackageIdForOwner(copies(), id, null))])) },
                    };
                };
                const { boundary } = agentStateProbe({ store, catalog, duroxide, model, turns, traces, runId, nodeExecutionId, workflowSessionId,
                    extra: bindingOf(nodeExecutionId, { pinned: pinnedId }) });

                await boundary("the agent state is entered", () => store.readNodeExecution(nodeExecutionId));
                await boundary("the child is spawned", async () => (await store.readAgentInvocation(nodeExecutionId))?.spawnedAt ?? null);
                await boundary("the child's turn reaches the model with complete_workflow_node", async () => turnOf(nodeExecutionId) ?? null);
                await boundary("the state is decided", async () => {
                    const node = await store.readNodeExecution(nodeExecutionId);
                    return node?.state === "completed" ? node : null;
                });
                const run = await boundary("the run ends", async () => {
                    const row = await store.readRun(runId);
                    return row && ENDED.includes(row.status) ? row : null;
                });
                expect(run).toMatchObject({ status: "completed", controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, terminalOutput: { verdict: "pinned" } });
                expect(await store.readNodeExecution(nodeExecutionId)).toMatchObject({ outcome: "accepted", winner: "agent", output: { verdict: "pinned" } });

                // The run kept its publication's revision: the invocation carries the pin, the child is bound to that exact
                // revision, and its real turn ran that revision's prompt.
                const invocation = await store.readAgentInvocation(nodeExecutionId);
                expect(invocation.task).toEqual({ source: "agent", ...pin });
                const child = invocation.childSessionId;
                expect(await catalog.getSession(child)).toMatchObject({ parentSessionId: workflowSessionId, agentId: reviewer,
                    owner: { provider: OWNER.provider, subject: OWNER.subject } });
                expect(await catalog.getSessionCreationConfig(child)).toMatchObject({ boundAgentName: reviewer, boundAgentPackageId: pinnedId });
                expect(await sessionOrchestrationVersion(client, child)).toBe(DURABLE_SESSION_LATEST_VERSION);
                await boundary("the child's turn gets its completion's receipt", async () => turnOf(nodeExecutionId)?.result ?? null);
                const turn = turnOf(nodeExecutionId);
                expect(turn.prompt).toContain("WORKFLOW NODE INVOCATION");
                expect(turn.system).toContain(marker("1.0.0"));
                expect(turn.system).not.toContain(marker("1.1.0"));
                expect(JSON.parse(turn.result)).toMatchObject({ ok: true, kind: "result", outcome: "accepted", nodeExecutionId, runId });
                // The worker installed that revision for the child, beside the active version; everyone else keeps the active one.
                const served = pickAgentCopyByPackageIdForOwner(copies(), pinnedId, null);
                expect(versionOf(served)).toBe("1.0.0");
                expect(served.pinnedRevision).toBe(v1.sha256);
                expect(versionOf(pickAgentCopyForOwner(copies(), null))).toBe("1.1.0");
                expect(versionOf(pickAgentCopyByPackageIdForOwner(copies(), v1.packageId, null))).toBe("1.1.0");

                // A later publication pins the revision the package is at now (1.1.0); the frozen publication keeps its own pin
                // (a published workflow is immutable: a later revision is a later workflow's publication).
                const laterSessionId = randomUUID();
                const later = await createWorkflowV2(host, {
                    workflowSessionId: laterSessionId, parentSessionId: parent, yaml: workflowNaming({ name: reviewer }), actor: ACTOR,
                    operationId: "create-later", publish: true, notifyParent: false,
                });
                expect(later.receipt, JSON.stringify(later.receipt.diagnostics)).toMatchObject({ valid: true, state: "published", run: null });
                const laterPin = { ...pin, version: "1.1.0", revision: v11.sha256 };
                const laterPinnedId = pinnedAgentPackageId(v11.packageId, v11.sha256);
                expect((await store.readDefinition(laterSessionId)).publishedAgentPins).toEqual({ review: laterPin });
                expect((await store.readDefinition(workflowSessionId)).publishedAgentPins).toEqual({ review: pin });

                // Its live run's child is bound to that revision, which the worker installs and serves to it; its real turn runs
                // the 1.1.0 prompt, never the 1.0.0 one, and completes its state.
                const laterStarted = await updateWorkflowV2(host, laterSessionId, { operation: "start", definitionHash: later.receipt.yamlSha256, inputs: {} },
                    { actor: ACTOR, operationId: "start-later" });
                const laterRunId = laterStarted.receipt.run.runId;
                const laterNode = nodeExecutionIdFor(laterRunId, "root", "review", 1);
                const laterProbe = agentStateProbe({ store, catalog, duroxide, model, turns, traces, runId: laterRunId, nodeExecutionId: laterNode,
                    workflowSessionId: laterSessionId, extra: bindingOf(laterNode, { pinned: pinnedId, later: laterPinnedId }) });
                await laterProbe.boundary("the later child is spawned", async () => (await store.readAgentInvocation(laterNode))?.spawnedAt ?? null);
                await laterProbe.boundary("the later child's turn reaches the model with complete_workflow_node", async () => turnOf(laterNode) ?? null);
                const laterRun = await laterProbe.boundary("the later run ends", async () => {
                    const row = await store.readRun(laterRunId);
                    return row && ENDED.includes(row.status) ? row : null;
                });
                expect(laterRun).toMatchObject({ status: "completed", controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, terminalOutput: { verdict: "pinned" } });
                const laterInvocation = await store.readAgentInvocation(laterNode);
                expect(laterInvocation.task).toEqual({ source: "agent", ...laterPin });
                expect(laterInvocation.childSessionId).not.toBe(child);
                expect(await catalog.getSessionCreationConfig(laterInvocation.childSessionId))
                    .toMatchObject({ boundAgentName: reviewer, boundAgentPackageId: laterPinnedId });
                await laterProbe.boundary("the later child's turn gets its completion's receipt", async () => turnOf(laterNode)?.result ?? null);
                const laterTurn = turnOf(laterNode);
                expect(laterTurn.system).toContain(marker("1.1.0"));
                expect(laterTurn.system).not.toContain(marker("1.0.0"));
                expect(JSON.parse(laterTurn.result)).toMatchObject({ ok: true, kind: "result", outcome: "accepted", nodeExecutionId: laterNode, runId: laterRunId });
                // Each revision is served to its own binding only; the default copy stays the active version.
                expect(pickAgentCopyByPackageIdForOwner(copies(), laterPinnedId, null)?.pinnedRevision).toBe(v11.sha256);
                expect(versionOf(pickAgentCopyByPackageIdForOwner(copies(), laterPinnedId, null))).toBe("1.1.0");
                expect(versionOf(pickAgentCopyByPackageIdForOwner(copies(), pinnedId, null))).toBe("1.0.0");
                expect(versionOf(pickAgentCopyForOwner(copies(), null))).toBe("1.1.0");
            });
        } finally {
            await catalog.close();
        }
    });

    it("runs an agent state's child under the workflow interface its publication pinned, after a republish with a new interface revision, and a later publication's child under the new one; a contract that does not match is refused before any child (R09, R18, T011, T070, T071)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const tag = randomUUID().slice(0, 8);
        const kit = `contract-kit-${tag}`;
        const reviewer = `contract-reviewer-${tag}`;
        const marker = version => `CONTRACT-REVIEWER-${tag}-${version}`;
        const RESULT_1 = { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } }, additionalProperties: false };
        const INPUT_2 = { type: "object", required: ["change"], properties: { change: { type: "string" } }, additionalProperties: false };
        const RESULT_2 = { type: "object", required: ["verdict", "notes"], properties: { verdict: { type: "string" }, notes: { type: "string" } },
            additionalProperties: false };
        /** review_change@1 (package 1.0.0) and review_change@2 (1.1.0): another input, output and outcome set. */
        const CONTRACT_1 = { version: "1", outputSchema: RESULT_1, outcomes: ["accepted"] };
        const CONTRACT_2 = { version: "2", inputSchema: INPUT_2, outputSchema: RESULT_2, outcomes: ["accepted", "changes_required"] };
        /** One version of the registry package: its schemaVersion 5 agent exports `contract` as review_change; its prompt names the version. */
        const writeVersion = (version, contract) => {
            const dir = join(env.baseDir, `agent-worker-contract-${tag}-${version}`);
            mkdirSync(join(dir, "agents"), { recursive: true });
            mkdirSync(join(dir, "contracts"), { recursive: true });
            writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: kit, version, description: "A workflow's contract reviewer, one interface revision at a time." }));
            writeFileSync(join(dir, "contracts", "review-result.schema.json"), JSON.stringify(contract.outputSchema));
            if (contract.inputSchema) writeFileSync(join(dir, "contracts", "review-input.schema.json"), JSON.stringify(contract.inputSchema));
            writeFileSync(join(dir, "agents", `${reviewer}.agent.md`), [
                "---", `name: ${reviewer}`, "description: Reviews a change against its workflow contract.", "schemaVersion: 5", `version: ${version}`,
                "workflowInterface:", "  name: review_change", `  version: "${contract.version}"`,
                ...(contract.inputSchema ? ["  inputSchema: ./contracts/review-input.schema.json"] : []),
                "  outputSchema: ./contracts/review-result.schema.json", `  outcomes: [${contract.outcomes.join(", ")}]`,
                "---", "", `${marker(version)}: review the change you are given against your workflow contract.`, "",
            ].join("\n"));
            return dir;
        };
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const registry = { catalog, artifactStore: new FilesystemArtifactStore(join(dirname(env.sessionStateDir), "artifacts")) };
        const publishVersion = (version, contract) => publishAgentPackageDir(registry, {
            dir: writeVersion(version, contract), scope: "shared", owner: OWNER, createdBy: "workflow-v2-agent-worker-test", isAdmin: false,
        });
        /** The interface a published version exports for the reviewer, as the registry keeps it in the version's manifest. */
        const exportOf = outcome => outcome.manifest.agents.find(agent => agent.name === reviewer)?.workflowInterface;
        const turns = [];
        const turnOf = stateExecutionId => turns.find(turn => turn.id === stateExecutionId);
        const { traces, traceWriter } = traceTail();
        const worker = {
            workerPool: "default", logLevel: "warning", traceWriter,
            agentPackages: { cacheDir: join(env.baseDir, `agent-worker-contract-packages-${tag}`), refreshIntervalMs: 0 },
        };
        try {
            // 1.0.0 exports review_change@1 and is the active version when the worker starts.
            const v1 = await publishVersion("1.0.0", CONTRACT_1);
            const export1 = exportOf(v1);
            expect(export1).toMatchObject({ name: "review_change", version: "1", inputSchema: null, outcomes: ["accepted"] });
            expect(export1.digest).toMatch(/^[0-9a-f]{64}$/);
            const pinnedId = pinnedAgentPackageId(v1.packageId, v1.sha256);
            await withScriptedModel(env, { respond: contractModel(turns), worker }, async ({ client, model, worker: running }) => {
                const duroxide = client._getDuroxideClient();
                const store = catalog.workflowStore();
                const copies = () => running.sessionManager.workerDefaults.agentPromptLookup[reviewer];
                const versionOf = copy => (!copy ? null : copy.prompt.includes(marker("1.0.0")) ? "1.0.0" : copy.prompt.includes(marker("1.1.0")) ? "1.1.0" : "other");
                const parent = randomUUID();
                await catalog.createSession(parent, { owner: OWNER });
                // Published as a 1.9.0 host publishes: the agent pinned from the registry, its interface matched and pinned.
                const host = { catalog, store, duroxideClient: duroxide, requests: true, resolveAgent: createWorkflowAgentResolver({ catalog }) };
                const named = ref => ({ name: reviewer, package: kit, interface: ref });
                const workflowSessionId = randomUUID();
                const created = await createWorkflowV2(host, {
                    workflowSessionId, parentSessionId: parent, yaml: contractedWorkflow(named("review_change@1"), CONTRACT_1), actor: ACTOR,
                    operationId: "create", publish: true, notifyParent: false,
                });
                expect(created.receipt, JSON.stringify(created.receipt.diagnostics)).toMatchObject({ valid: true, state: "published", run: null });
                const pin = { name: reviewer, package: kit, version: "1.0.0", packageId: v1.packageId, revision: v1.sha256,
                    interface: { name: "review_change", version: "1", digest: export1.digest } };
                expect((await store.readDefinition(workflowSessionId)).publishedAgentPins).toEqual({ review: pin });

                // Republished with review_change@2: 1.1.0 is the registry's and this worker's active version. The publication keeps its pin.
                const v11 = await publishVersion("1.1.0", CONTRACT_2);
                const export2 = exportOf(v11);
                expect(v11.packageId).toBe(v1.packageId);
                expect(v11.sha256).not.toBe(v1.sha256);
                expect(export2).toMatchObject({ name: "review_change", version: "2", outcomes: ["accepted", "changes_required"] });
                expect(export2.digest).not.toBe(export1.digest);
                await running.refreshAgentPackages();
                expect(versionOf(pickAgentCopyForOwner(copies(), null))).toBe("1.1.0");
                expect((await store.readDefinition(workflowSessionId)).publishedAgentPins).toEqual({ review: pin });

                // What no longer matches the active version's interface is refused at publication and stays a draft: no run,
                // so no child and no model turn. Nothing is inferred: neither the old name nor the new name with the old contract.
                const refusedPublication = async (ref, contract, problems, label) => {
                    const draftId = randomUUID();
                    const draft = await createWorkflowV2(host, {
                        workflowSessionId: draftId, parentSessionId: parent, yaml: contractedWorkflow(named(ref), contract), actor: ACTOR,
                        operationId: `create-${label}`, notifyParent: false,
                    });
                    expect(draft.receipt, JSON.stringify(draft.receipt.diagnostics)).toMatchObject({ valid: true, state: "draft", run: null });
                    const refusal = await updateWorkflowV2(host, draftId, { operation: "publish", expectedRevision: 1, definitionHash: draft.receipt.yamlSha256 },
                        { actor: ACTOR, operationId: `publish-${label}` }).then(() => null, error => error);
                    expect(refusal?.code, refusal?.message).toBe("CONTRACT_MISMATCH");
                    expect(refusal.details).toMatchObject({ stateId: "review", agent: reviewer, package: kit, interface: ref, packageVersion: "1.1.0", problems });
                    expect(await store.readDefinition(draftId)).toMatchObject({ state: "draft", publishedRevision: null, publishedAgentPins: null });
                    expect(await store.listRuns(draftId)).toEqual([]);
                };
                await refusedPublication("review_change@1", CONTRACT_1, ["its agent exports review_change@2, not review_change@1"], "stale-name");
                await refusedPublication("review_change@2", CONTRACT_1, [
                    "its outcomes [accepted] are not the interface's [accepted, changes_required]",
                    "its outputSchema is not exactly the interface's output schema",
                    "its inputSchema is not exactly the interface's input schema",
                ], "old-contract");
                expect(turns).toEqual([]);

                // A live run of the first publication.
                const started = await updateWorkflowV2(host, workflowSessionId, { operation: "start", definitionHash: created.receipt.yamlSha256, inputs: {} },
                    { actor: ACTOR, operationId: "start" });
                const runId = started.receipt.run.runId;
                const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);
                /** The case's own records for the evidence: the state's task, its child's binding and what the worker serves. */
                const bindingOf = (stateExecutionId, ids) => async () => {
                    const invocation = await store.readAgentInvocation(stateExecutionId);
                    return {
                        ids, task: invocation?.task ?? null,
                        creationConfig: invocation ? await catalog.getSessionCreationConfig(invocation.childSessionId) : null,
                        served: { active: versionOf(pickAgentCopyForOwner(copies(), null)),
                            ...Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, versionOf(pickAgentCopyByPackageIdForOwner(copies(), id, null))])) },
                    };
                };
                const { boundary } = agentStateProbe({ store, catalog, duroxide, model, turns, traces, runId, nodeExecutionId, workflowSessionId,
                    extra: bindingOf(nodeExecutionId, { pinned: pinnedId }) });
                await boundary("the agent state is entered", () => store.readNodeExecution(nodeExecutionId));
                await boundary("the child is spawned", async () => (await store.readAgentInvocation(nodeExecutionId))?.spawnedAt ?? null);
                await boundary("the child's turn reaches the model with complete_workflow_node", async () => turnOf(nodeExecutionId) ?? null);
                await boundary("the child's turn gets both completions' answers", async () => turnOf(nodeExecutionId)?.results?.[1] ?? null);
                const run = await boundary("the run ends", async () => {
                    const row = await store.readRun(runId);
                    return row && ENDED.includes(row.status) ? row : null;
                });
                expect(run).toMatchObject({ status: "completed", controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, terminalOutput: { verdict: "approved" } });
                expect(await store.readNodeExecution(nodeExecutionId)).toMatchObject({ outcome: "accepted", winner: "agent", output: { verdict: "approved" } });

                // The run kept its publication's revision: the child is bound to it and its real turn ran that revision's prompt.
                const invocation = await store.readAgentInvocation(nodeExecutionId);
                expect(invocation.task).toEqual({ source: "agent", name: reviewer, package: kit, version: "1.0.0", packageId: v1.packageId, revision: v1.sha256 });
                expect(await catalog.getSessionCreationConfig(invocation.childSessionId)).toMatchObject({ boundAgentName: reviewer, boundAgentPackageId: pinnedId });
                const turn = turnOf(nodeExecutionId);
                expect(turn.system).toContain(marker("1.0.0"));
                expect(turn.system).not.toContain(marker("1.1.0"));
                // Its wrapper carries exactly the pinned interface's contract: review_change@1's outcomes and output schema, no input schema.
                expect(turn.invocation).toMatchObject({ nodeExecutionId, runId, stateId: "review", input: { change: "rename a field" }, inputSchema: null,
                    outcomes: export1.outcomes, taskSource: { agent: reviewer, package: kit, version: "1.0.0" } });
                expect(turn.invocation.schemas[turn.invocation.outputSchema]).toEqual(export1.outputSchema);
                // A completion under the new interface (its outcome and result) is refused by the pinned contract; one under it decides the state.
                const [tried, decided] = turn.results.map(text => JSON.parse(text));
                expect(tried).toMatchObject({ ok: false, error: { code: "OUTPUT_INVALID", attemptsLeft: 2 } });
                expect(tried.error.problems).toEqual(expect.arrayContaining([{ path: "outcome", message: "outcome must be one of accepted." }]));
                expect(tried.error.problems.length).toBeGreaterThan(1);
                expect(decided).toMatchObject({ ok: true, kind: "result", outcome: "accepted", nodeExecutionId, runId });
                expect(versionOf(pickAgentCopyByPackageIdForOwner(copies(), pinnedId, null))).toBe("1.0.0");
                expect(versionOf(pickAgentCopyForOwner(copies(), null))).toBe("1.1.0");

                // A later publication naming review_change@2 with exactly its contract pins the new revision and the new digest; the
                // first publication keeps its own pin.
                const laterSessionId = randomUUID();
                const later = await createWorkflowV2(host, {
                    workflowSessionId: laterSessionId, parentSessionId: parent, yaml: contractedWorkflow(named("review_change@2"), CONTRACT_2), actor: ACTOR,
                    operationId: "create-later", publish: true, notifyParent: false,
                });
                expect(later.receipt, JSON.stringify(later.receipt.diagnostics)).toMatchObject({ valid: true, state: "published", run: null });
                const laterPin = { ...pin, version: "1.1.0", revision: v11.sha256, interface: { name: "review_change", version: "2", digest: export2.digest } };
                const laterPinnedId = pinnedAgentPackageId(v11.packageId, v11.sha256);
                expect((await store.readDefinition(laterSessionId)).publishedAgentPins).toEqual({ review: laterPin });
                expect((await store.readDefinition(workflowSessionId)).publishedAgentPins).toEqual({ review: pin });

                const laterStarted = await updateWorkflowV2(host, laterSessionId, { operation: "start", definitionHash: later.receipt.yamlSha256, inputs: {} },
                    { actor: ACTOR, operationId: "start-later" });
                const laterRunId = laterStarted.receipt.run.runId;
                const laterNode = nodeExecutionIdFor(laterRunId, "root", "review", 1);
                const laterProbe = agentStateProbe({ store, catalog, duroxide, model, turns, traces, runId: laterRunId, nodeExecutionId: laterNode,
                    workflowSessionId: laterSessionId, extra: bindingOf(laterNode, { pinned: pinnedId, later: laterPinnedId }) });
                await laterProbe.boundary("the later child is spawned", async () => (await store.readAgentInvocation(laterNode))?.spawnedAt ?? null);
                await laterProbe.boundary("the later child's turn reaches the model with complete_workflow_node", async () => turnOf(laterNode) ?? null);
                await laterProbe.boundary("the later child's turn gets both completions' answers", async () => turnOf(laterNode)?.results?.[1] ?? null);
                const laterRun = await laterProbe.boundary("the later run ends", async () => {
                    const row = await store.readRun(laterRunId);
                    return row && ENDED.includes(row.status) ? row : null;
                });
                expect(laterRun).toMatchObject({ status: "completed", controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION,
                    terminalOutput: { verdict: "rework", notes: "rename it everywhere" } });
                expect(await store.readNodeExecution(laterNode)).toMatchObject({ outcome: "changes_required", winner: "agent",
                    output: { verdict: "rework", notes: "rename it everywhere" } });
                const laterInvocation = await store.readAgentInvocation(laterNode);
                expect(laterInvocation.task).toEqual({ source: "agent", name: reviewer, package: kit, version: "1.1.0", packageId: v11.packageId, revision: v11.sha256 });
                expect(laterInvocation.childSessionId).not.toBe(invocation.childSessionId);
                expect(await catalog.getSessionCreationConfig(laterInvocation.childSessionId))
                    .toMatchObject({ boundAgentName: reviewer, boundAgentPackageId: laterPinnedId });
                const laterTurn = turnOf(laterNode);
                expect(laterTurn.system).toContain(marker("1.1.0"));
                expect(laterTurn.system).not.toContain(marker("1.0.0"));
                // Its wrapper carries review_change@2's contract: the input it was admitted with, its input schema, output schema and outcomes.
                expect(laterTurn.invocation).toMatchObject({ nodeExecutionId: laterNode, runId: laterRunId, stateId: "review", input: { change: "rename a field" },
                    outcomes: export2.outcomes, taskSource: { agent: reviewer, package: kit, version: "1.1.0" } });
                expect(laterTurn.invocation.schemas[laterTurn.invocation.inputSchema]).toEqual(export2.inputSchema);
                expect(laterTurn.invocation.schemas[laterTurn.invocation.outputSchema]).toEqual(export2.outputSchema);
                // A result without @2's notes is refused; one with them decides the state.
                const [laterTried, laterDecided] = laterTurn.results.map(text => JSON.parse(text));
                expect(laterTried).toMatchObject({ ok: false, error: { code: "OUTPUT_INVALID", attemptsLeft: 2 } });
                expect(laterTried.error.problems.length).toBeGreaterThan(0);
                expect(laterTried.error.problems.some(problem => problem.path === "outcome")).toBe(false);
                expect(laterDecided).toMatchObject({ ok: true, kind: "result", outcome: "changes_required", nodeExecutionId: laterNode, runId: laterRunId });
                expect(versionOf(pickAgentCopyByPackageIdForOwner(copies(), laterPinnedId, null))).toBe("1.1.0");
                expect(versionOf(pickAgentCopyByPackageIdForOwner(copies(), pinnedId, null))).toBe("1.0.0");
            });
        } finally {
            await catalog.close();
        }
    });
});
