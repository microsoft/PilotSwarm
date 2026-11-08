/**
 * Workflow Simplified stage 2.2: an agent's test of a revision, on request (spec "Agent-only test, on request"; the
 * coordinator's readings item 6). The chat tests a revision of its definition only when the person asks; Start never needs
 * a test. One `workflow_definition` test call runs the revision to an end with prepared answers and returns a report.
 *
 * - The test bench: a workflow child of the chat (service_kind workflow-test, test-bench.ts) whose draft is the revision's
 *   YAML, and one test run of it (startWorkflowV2Test, agent mode mocked): its scripts run for real (files, network), and
 *   what the framework brokers is intercepted (a script's tool calls, agent states, sends and requests).
 * - Prepared answers (fixtures, test-mode.ts) answer the intercepted calls; a fixture without arguments answers any call of
 *   its tool or state. A call no fixture answers fails the test, which names it; the run is canceled.
 * - Waits pass at once: whenever every open step only waits for its timer (wait states, and receive states with a
 *   deadline), the run's virtual clock is moved to the next deadline; the report says how long they would take.
 * - Never: wakes the chat (the bench notifies nobody), shows as Workflow #N (no chat pin) or appears in a session list.
 * - The call waits up to WORKFLOW_DEFINITION_TEST_WAIT_MS for the end (a turn with no event for 5 minutes is treated as
 *   lost, so the wait stays under that), then answers with the test's id; the chat reads it again with that id.
 */
import { systemChildAgentUUID } from "../../agent-loader.js";
import type { SessionOwnerInfo } from "../../types.js";
import type { WorkflowToolBinding } from "../tool-policy.js";
import { canonicalJson, jsonbSafeText, type JsonValue } from "./json.js";
import {
    WORKFLOW_V2_TEST_ADVANCE_MAX_SECONDS, WORKFLOW_V2_TEST_EPOCH, WorkflowStoreError,
    type WorkflowActor, type WorkflowNodeExecutionRow, type WorkflowRunRow, type WorkflowTestInterception,
} from "./store.js";
import { advanceWorkflowV2Test, controlWorkflowV2Run, createWorkflowV2, startWorkflowV2Test, type WorkflowV2Host } from "./service.js";
import { requireWorkflowScripts } from "./scripts-gate.js";
import { WORKFLOW_V2_MILESTONE_IR_VERSION } from "./compiler.js";
import { definitionOf } from "./chat-definitions.js";
import { matchTestFixture, storedTestFixtures, testResultFor, WORKFLOW_V2_TEST_NOTICE, type WorkflowTestFixture } from "./test-mode.js";
import type { WorkflowIR } from "./compiler.js";
import { workflowErrorWords } from "./error-words.js";
import { isWorkflowTestBench } from "./test-bench.js";

/** How long one test call waits for the test to end before it answers with the test's id (under a turn's 5-minute guard). */
export const WORKFLOW_DEFINITION_TEST_WAIT_MS = 240_000;
/** How often the wait looks at the test run. */
export const WORKFLOW_DEFINITION_TEST_POLL_MS = 200;
/** How long an intercepted call may wait for its prepared answer before the test fails naming it. */
export const WORKFLOW_DEFINITION_TEST_ANSWER_GRACE_MS = 5_000;
/** The agent tests of a definition kept: older ended ones are deleted when a new one starts. */
export { WORKFLOW_DEFINITION_TESTS_KEPT } from "./chat-definition-store.js";
import { WORKFLOW_DEFINITION_TESTS_KEPT } from "./chat-definition-store.js";

const ACTIVE = new Set(["admitted", "running", "paused"]);
const STOPPING_REASON = "TEST_UNANSWERED";
/** Agent Smith 1.4.2 smoke (F-SM2): a call whose prepared answer has the wrong shape is refused, not "unanswered". */
const REFUSED_REASON = "TEST_ANSWER_REFUSED";

/**
 * The shape a prepared answer must have for a kind of call (as testResultFor checks it), with an example, and what a failure
 * looks like: said when a test refuses an answer, so the chat can fix its fixture.
 */
export function testAnswerShapeWords(operation: string, outcomes: readonly string[] = []): string {
    const failure = ' A failure is { kind: "error", value: { code: "execution_failed", message: "..." } } (code: a runtime error code).';
    if (operation === "agent") {
        return `An agent step's answer is { kind: "success", value: { outcome: ${outcomes.length ? outcomes.map(item => `"${item}"`).join(" | ") : "<one of its outcomes>"}, `
            + "output: <its output, as its outputSchema says> } }." + failure;
    }
    if (operation === "request") {
        return 'A request step\'s answer is { kind: "success", value: { response: <the answer, as its contract\'s response schema says> } }, '
            + 'or { kind: "success", value: { decline: { reason: "..." } } } to decline it.' + failure;
    }
    if (operation === "send") return 'A send step\'s answer is { kind: "success", value: <any value> }.' + failure;
    return 'A tool call\'s answer is { kind: "success", value: <what the tool returns> }.' + failure;
}

/** The words of an intercepted call: "tool call read_build in step poll", "agent step summarize", "send step notify". */
function callWords(interception: WorkflowTestInterception, stateId: string | null): string {
    if (interception.operation === "tool.call") return `tool call ${interception.tool ?? "?"}${stateId ? ` in step ${stateId}` : ""}`;
    const kind = interception.operation === "agent" ? "agent" : interception.operation === "send" ? "send" : "request";
    return `${kind} step ${stateId ?? "?"}`;
}

const preview = (value: JsonValue, max = 300): string => jsonbSafeText(canonicalJson(value), max);

export interface ChatTestReport {
    ok: true;
    operation: "test";
    testId: string;
    runId: string;
    definitionId: string;
    name: string;
    revision: number;
    status: "passed" | "failed" | "running";
    run: { status: string; outcome: string | null; terminalState: string | null; errorWords: string | null };
    path: Array<{ step: string; visit: number; outcome: string | null; resultKind: string | null; mocked: boolean; output?: string; errorWords?: string }>;
    firstError: { step: string; words: string | null } | null;
    /** A call no prepared answer answered, its arguments, and the shape its answer needs. */
    unanswered: { call: string; arguments: string; expected: string } | null;
    /** A call whose prepared answer the test refused (its shape), and why, with the shape it needs. */
    refused: { call: string; reason: string } | null;
    answeredCalls: Array<{ call: string; by: "prepared answer" | "parent" }>;
    waitedVirtualSeconds: number;
    tookSeconds: number;
    notice: string;
    message: string;
}

/** The test run of a test bench: its newest test run. */
async function testRunOf(host: Pick<WorkflowV2Host, "store">, benchId: string): Promise<WorkflowRunRow> {
    const runs = (await host.store.listRuns(benchId)).filter(run => run.mode === "test");
    const run = runs[runs.length - 1];
    if (!run) throw new WorkflowStoreError("TEST_NOT_FOUND", `Test ${benchId} has no test run.`);
    return run;
}

/** A fixture for an open interception (a tool call by its tool and arguments; another call by its state and input). */
function fixtureFor(fixtures: readonly WorkflowTestFixture[], interception: WorkflowTestInterception, node: WorkflowNodeExecutionRow | null)
    : WorkflowTestFixture | null {
    return interception.operation === "tool.call"
        ? matchTestFixture(fixtures, { operation: "tool.call", tool: interception.tool, state: null, argumentsSha256: interception.argumentsSha256 })
        : matchTestFixture(fixtures, { operation: interception.operation, tool: null, state: node?.nodeId ?? null, argumentsSha256: node?.inputSha256 ?? "" });
}

/**
 * The report of a test (its run as it is now): the path it took, each visit's outcome and output, its first error, a call it
 * had no answer for, the calls answered, the virtual time its waits took and the time it took.
 */
export async function chatTestReport(host: Pick<WorkflowV2Host, "store">, bench: { testId: string; definitionId: string; name: string; revision: number },
    run: WorkflowRunRow): Promise<ChatTestReport> {
    const [nodes, interceptions] = await Promise.all([host.store.listNodeExecutions(run.runId, 500), host.store.listInterceptions(run.runId, 500)]);
    const stateOf = new Map(nodes.map(node => [node.nodeExecutionId, node.nodeId]));
    const path = nodes.map(node => ({
        step: node.nodeId, visit: node.ordinal, outcome: node.outcome, resultKind: node.resultKind, mocked: node.winner === "test",
        ...(node.resultKind === "business" && node.state === "completed" ? { output: preview(node.output) } : {}),
        ...(node.resultKind === "runtime_error" ? { errorWords: workflowErrorWords(node.error) ?? undefined } : {}),
    }));
    const failed = nodes.find(node => node.resultKind === "runtime_error") ?? null;
    const waiting = interceptions.find(item => item.state === "awaiting_parent") ?? null;
    const ended = !ACTIVE.has(run.status);
    // F-SM2: the call had a prepared answer, and the test refused it (its shape); the reason says why and the shape it needs.
    const endedWith = run.terminalError !== null && typeof (run.terminalError as { message?: unknown }).message === "string"
        ? (run.terminalError as { message: string }).message : "";
    const refused = waiting && ended && endedWith.startsWith(`${REFUSED_REASON}: `)
        ? { call: callWords(waiting, stateOf.get(waiting.nodeExecutionId) ?? null), reason: endedWith.slice(REFUSED_REASON.length + 2) } : null;
    const waitingCall = waiting ? callWords(waiting, stateOf.get(waiting.nodeExecutionId) ?? null) : "";
    // The shape the call's answer needs: as the cancel said it (with an agent step's outcomes), else by its kind.
    const unansweredLead = `${STOPPING_REASON}: no prepared answer for the ${waitingCall}. `;
    const unanswered = waiting && !refused && (ended || run.stop !== null)
        ? { call: waitingCall, arguments: preview(waiting.arguments, 500),
            expected: endedWith.startsWith(unansweredLead) && endedWith.length > unansweredLead.length ? endedWith.slice(unansweredLead.length)
                : testAnswerShapeWords(waiting.operation) } : null;
    // The step the test stopped at has the cancel's reason as its error (the cancel names the call, the visit says "canceled").
    const stoppedAt = waiting && (refused || unanswered)
        ? { step: stateOf.get(waiting.nodeExecutionId) ?? waitingCall,
            words: refused ? refused.reason : `no prepared answer for the ${waitingCall}. ${unanswered!.expected}` } : null;
    const status: ChatTestReport["status"] = !ended ? "running"
        : run.status === "completed" && run.terminalOutcome === "succeeded" && !unanswered && !refused ? "passed" : "failed";
    const virtualMs = run.virtualNow ? run.virtualNow.getTime() - Date.parse(WORKFLOW_V2_TEST_EPOCH) : 0;
    const tookMs = (run.finishedAt ?? new Date()).getTime() - run.createdAt.getTime();
    const runWords = run.terminalError === null ? null : workflowErrorWords(run.terminalError);
    const what = status === "running" ? `The test of ${bench.name} revision ${bench.revision} is still running. Read it again with `
        + `workflow_definition operation test and test_id ${bench.testId}; do not start another test meanwhile.`
        : status === "passed" ? `The test of ${bench.name} revision ${bench.revision} passed: it ended at ${run.terminalNodeId ?? "its end"} (succeeded).`
            : refused ? `The test of ${bench.name} revision ${bench.revision} failed: ${refused.reason} Fix that fixture and test again.`
            : unanswered ? `The test of ${bench.name} revision ${bench.revision} failed: no prepared answer for the ${unanswered.call}. Add a fixture `
                + `for it (or fix the definition) and test again. ${unanswered.expected}`
                : `The test of ${bench.name} revision ${bench.revision} failed: it ended ${run.status}${run.terminalOutcome ? ` (${run.terminalOutcome})` : ""}`
                    + `${failed ? ` after ${failed.nodeId} failed: ${workflowErrorWords(failed.error) ?? failed.outcome ?? "an error"}` : runWords ? `: ${runWords}` : ""}.`;
    return {
        ok: true, operation: "test", testId: bench.testId, runId: run.runId, definitionId: bench.definitionId, name: bench.name, revision: bench.revision,
        status, run: { status: run.status, outcome: run.terminalOutcome, terminalState: run.terminalNodeId, errorWords: runWords },
        path, firstError: stoppedAt ?? (failed ? { step: failed.nodeId, words: workflowErrorWords(failed.error) } : null), unanswered, refused,
        answeredCalls: interceptions.filter(item => item.response !== null).map(item => ({
            call: callWords(item, stateOf.get(item.nodeExecutionId) ?? null), by: item.response?.disposition === "fixture" ? "prepared answer" as const : "parent" as const })),
        waitedVirtualSeconds: Math.max(0, Math.round(virtualMs / 1000)), tookSeconds: Math.max(0, Math.round(tookMs / 1000)),
        notice: WORKFLOW_V2_TEST_NOTICE, message: what,
    };
}

/**
 * Start a test of a revision of the chat's definition (default its newest valid one) on a new test bench, with its
 * inputs, initial variables and prepared answers. Refused on a host that runs no tests (WORKFLOW_TEST_UNAVAILABLE), for a
 * revision with errors, and, on a host that runs no scripts, for a revision with a script node (before anything is made).
 */
export async function startChatWorkflowTest(host: WorkflowV2Host, request: {
    ownerSessionId: string;
    definition: { definitionId?: string | null; name?: string | null };
    revision?: number | null;
    inputs: JsonValue;
    vars?: { [key: string]: JsonValue } | null;
    fixtures: WorkflowTestFixture[];
    operationId: string;
    actor: WorkflowActor;
    owner: () => Promise<SessionOwnerInfo | null>;
    binding: () => Promise<WorkflowToolBinding | null>;
}): Promise<{ testId: string; runId: string; definitionId: string; name: string; revision: number }> {
    requireTestHost(host);
    const definition = await definitionOf(host, request.ownerSessionId, request.definition);
    const revision = request.revision ?? await host.store.chat.newestValidRevision(definition.definitionId);
    if (revision === null) throw new WorkflowStoreError("DEFINITION_INVALID", `${definition.name} has no valid revision yet, so it cannot be tested. Nothing was tested.`);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "revision must be a revision number.");
    const saved = await host.store.chat.readRevision(definition.definitionId, revision);
    if (!saved) throw new WorkflowStoreError("REVISION_NOT_FOUND", `${definition.name} has no revision ${revision}.`);
    if (!saved.valid) throw new WorkflowStoreError("DEFINITION_INVALID", `Revision ${revision} of ${definition.name} has errors, so it cannot be tested. Nothing was tested.`);
    // The scripts gate first, on the revision it would test, before anything is made or read of the chat's session.
    if (host.scripts === false) {
        requireWorkflowScripts(host, await host.store.chat.readRevisionIr(definition.definitionId, revision, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION }), "test");
    }
    const owner = await request.owner();
    const binding = await request.binding();
    const benchId = systemChildAgentUUID(request.ownerSessionId, `workflow:test:${request.operationId}`);
    const created = await createWorkflowV2(host, {
        workflowSessionId: benchId, parentSessionId: request.ownerSessionId, ...(owner ? { owner } : {}), yaml: saved.yaml, actor: request.actor,
        operationId: `test-bench:${request.operationId}`, publish: false, notifyParent: false, ...(binding ? { binding } : {}),
        testBench: { definitionId: definition.definitionId, revision },
    });
    const started = await startWorkflowV2Test(host, benchId, {
        expectedRevision: created.receipt.revision, definitionHash: created.receipt.yamlSha256, inputs: request.inputs,
        ...(request.vars ? { vars: request.vars } : {}), agentMode: "mocked", fixtures: request.fixtures,
    }, { actor: request.actor, operationId: `test-run:${request.operationId}`,
        bench: { ownerSessionId: request.ownerSessionId, definitionId: definition.definitionId } });
    const runId = started.receipt.run?.runId;
    if (!runId) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Test ${benchId} was admitted without its run.`);
    // Best effort: older ended tests of this definition are deleted (their rows stay); a failure never refuses this test.
    await host.store.chat.retireTests(request.ownerSessionId, definition.definitionId, WORKFLOW_DEFINITION_TESTS_KEPT).catch(() => undefined);
    return { testId: benchId, runId, definitionId: definition.definitionId, name: definition.name, revision };
}

/**
 * A host that runs Workflow tests (a workflow request turn), or WORKFLOW_TEST_UNAVAILABLE. S2RT-F9: checked before a new test
 * and before a test is read again by its id (which can advance its clock or end it), so neither runs where tests cannot.
 */
export function requireTestHost(host: Pick<WorkflowV2Host, "requests">): void {
    if (host.requests !== true) {
        throw new WorkflowStoreError("WORKFLOW_TEST_UNAVAILABLE", "This deployment cannot run Workflow tests. Nothing was tested; start the revision "
            + "when the person asks, or tell them a test cannot run here.");
    }
}

/** A chat's test bench by its id: the chat's own, or TEST_NOT_FOUND. Its definition, name and revision. */
export async function chatTestBench(host: Pick<WorkflowV2Host, "catalog" | "store">, ownerSessionId: string, testId: string)
    : Promise<{ testId: string; definitionId: string; name: string; revision: number }> {
    const [row, config] = await Promise.all([host.catalog.getSession(testId), host.catalog.getSessionCreationConfig?.(testId) ?? null]);
    const bench = config && typeof config.agentTest === "object" && config.agentTest !== null ? config.agentTest as { definitionId?: unknown; revision?: unknown } : null;
    if (!row || row.deletedAt || row.parentSessionId !== ownerSessionId || !isWorkflowTestBench(row) || !bench
        || typeof bench.definitionId !== "string" || !Number.isSafeInteger(bench.revision)) {
        throw new WorkflowStoreError("TEST_NOT_FOUND", `This chat has no test ${testId}.`);
    }
    const definition = await host.store.chat.readDefinition(bench.definitionId);
    return { testId, definitionId: bench.definitionId, name: definition?.name ?? "(deleted definition)", revision: bench.revision as number };
}

/**
 * Wait for a test to end (at most `waitMs`), moving its virtual clock past its waits, and failing it when a call has no
 * prepared answer; then its report (status running when it has not ended yet).
 */
export async function waitChatWorkflowTest(host: Pick<WorkflowV2Host, "catalog" | "store" | "duroxideClient" | "requests">,
    bench: { testId: string; definitionId: string; name: string; revision: number },
    options: { waitMs?: number; pollMs?: number; graceMs?: number; actor: WorkflowActor; sleep?: (ms: number) => Promise<void> }): Promise<ChatTestReport> {
    const waitMs = options.waitMs ?? WORKFLOW_DEFINITION_TEST_WAIT_MS;
    const pollMs = options.pollMs ?? WORKFLOW_DEFINITION_TEST_POLL_MS;
    const graceMs = options.graceMs ?? WORKFLOW_DEFINITION_TEST_ANSWER_GRACE_MS;
    const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const deadline = Date.now() + waitMs;
    let run = await testRunOf(host, bench.testId);
    const fixtures = storedTestFixtures(await host.store.readTestFixtures(run.runId));
    const firstSeen = new Map<string, number>();
    // F-SM2: a prepared answer the test refuses (testResultFor, as the run checked it) fails the test at once, saying why.
    let tested: WorkflowIR | null = null;
    const testedIr = async (): Promise<WorkflowIR> => {
        tested ??= await host.store.readRevisionIr(run.workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
        return tested;
    };
    // An agent step's outcomes, for the shape its answer needs (none when its revision cannot be read).
    const outcomesOf = async (node: WorkflowNodeExecutionRow | null): Promise<string[]> => {
        if (!node) return [];
        try {
            const state = (await testedIr()).nodes[node.nodeId];
            return state?.type === "agent" ? [...state.outcomes] : [];
        } catch {
            return [];
        }
    };
    const refusalOf = async (item: WorkflowTestInterception, node: WorkflowNodeExecutionRow | null, fixture: WorkflowTestFixture)
        : Promise<{ message: string; outcomes: string[] } | null> => {
        if (item.operation === "tool.call" || !node) return null;
        try {
            const tested = await testedIr();
            const state = tested.nodes[node.nodeId];
            if (!state) return null;
            try {
                testResultFor(item, state, tested, run.irSha256, fixture.response);
                return null;
            } catch (error) {
                if (!(error instanceof WorkflowStoreError) || error.code !== "TEST_RESPONSE_INVALID") return null;
                return { message: error.message, outcomes: state.type === "agent" ? [...state.outcomes] : [] };
            }
        } catch {
            return null;
        }
    };
    for (;;) {
        run = (await host.store.readRun(run.runId)) ?? run;
        if (!ACTIVE.has(run.status) || run.stop !== null || Date.now() >= deadline) break;
        // A call without a prepared answer fails the test (its run is canceled), naming the call.
        const open = (await host.store.listOpenInterceptions(run.runId, 20)).rows;
        let unanswered: WorkflowTestInterception | null = null;
        let refusal: { message: string; outcomes: string[] } | null = null;
        for (const item of open) {
            const node = await host.store.readNodeExecution(item.nodeExecutionId);
            const seen = firstSeen.get(item.interceptionId) ?? Date.now();
            firstSeen.set(item.interceptionId, seen);
            const fixture = fixtureFor(fixtures, item, node);
            refusal = fixture ? await refusalOf(item, node, fixture) : null;
            if (!fixture || refusal || Date.now() - seen >= graceMs) { unanswered = item; break; }
        }
        if (unanswered) {
            const node = await host.store.readNodeExecution(unanswered.nodeExecutionId);
            const call = callWords(unanswered, node?.nodeId ?? null);
            const reason = refusal
                ? `${REFUSED_REASON}: the prepared answer for the ${call} was refused: ${jsonbSafeText(refusal.message, 600)} `
                    + testAnswerShapeWords(unanswered.operation, refusal.outcomes)
                : `${STOPPING_REASON}: no prepared answer for the ${call}. ${testAnswerShapeWords(unanswered.operation, await outcomesOf(node))}`;
            await controlWorkflowV2Run(host, bench.testId, { operation: "cancel", runId: run.runId, reason },
            { actor: options.actor, operationId: `test-unanswered:${run.runId}` }).catch(() => undefined);
            await sleep(pollMs);
            continue;
        }
        // Waits pass at once: when every open step only waits for its timer, the clock moves to the next deadline.
        const pending = (await host.store.listOpenNodeExecutions(run.runId, 200)).rows.filter(node => node.nodeType !== "parallel");
        const timers = pending.filter(node => node.nodeType === "wait" || (node.nodeType === "messaging" && node.receive !== null));
        if (open.length === 0 && pending.length > 0 && timers.length === pending.length && run.virtualNow !== null) {
            const due = timers.map(node => node.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY).reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
            if (!Number.isFinite(due)) {
                // A receive with no deadline waits for a message a test cannot send: the test cannot go on.
                await controlWorkflowV2Run(host, bench.testId, { operation: "cancel", runId: run.runId,
                    reason: `TEST_STUCK: step ${timers[0].nodeId} waits for a message, and a test cannot send one.` },
                { actor: options.actor, operationId: `test-stuck:${run.runId}` }).catch(() => undefined);
                await sleep(pollMs);
                continue;
            }
            const seconds = Math.min(WORKFLOW_V2_TEST_ADVANCE_MAX_SECONDS, Math.max(1, Math.ceil((due - run.virtualNow.getTime()) / 1000)));
            // Named by the virtual time it moves from and how far, so a later read of the same test (test_id) never reuses
            // an earlier advance's id for another request, and a repeat of the same advance is answered by its receipt.
            await advanceWorkflowV2Test(host, bench.testId, { runId: run.runId, seconds },
                { actor: options.actor, operationId: `test-advance:${run.runId}:${run.virtualNow.getTime()}:${seconds}` }).catch(() => undefined);
        }
        await sleep(pollMs);
    }
    return chatTestReport(host, bench, run);
}
