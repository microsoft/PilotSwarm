/** The command queue every session listens on; management and parents send `{ type: "cmd" }` here. */
export const WORKFLOW_COMMAND_QUEUE = "messages";

/** duroxide-node prefixes activity errors; the person reading the result needs only the cause. */
export const ACTIVITY_ERROR_PREFIX = /^Activity '[^']+' JS execution failed: [A-Za-z]+, (?:[A-Za-z]*Error: )?/;

export function workflowErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(ACTIVITY_ERROR_PREFIX, "");
}

/** A lifecycle command read from the command queue, or null for anything else. */
export function parseWorkflowCommand(raw: unknown): { cmd: "cancel" | "done" | "delete"; reason?: string; requestedBy?: string } | null {
    let message: any = raw;
    if (typeof message === "string") {
        try { message = JSON.parse(message); } catch { return null; }
    }
    if (!message || typeof message !== "object" || message.type !== "cmd") return null;
    if (message.cmd !== "cancel" && message.cmd !== "done" && message.cmd !== "delete") return null;
    const reason = typeof message.args?.reason === "string" && message.args.reason.trim() ? message.args.reason.trim() : undefined;
    const requestedBy = typeof message.requestedBy === "string" && message.requestedBy ? message.requestedBy : undefined;
    return { cmd: message.cmd, ...(reason ? { reason } : {}), ...(requestedBy ? { requestedBy } : {}) };
}

/** The catch route a runtime error takes when its own code has no route. */
export const FAILURE_ROUTE = "failure";

/** A parallel state's business outcomes: every branch succeeded, or not (design 02 parallel scope and join; D10). */
export const PARALLEL_JOINED = "joined";

/** The most branches one parallel state runs (its manifest's items). */
export const WORKFLOW_PARALLEL_MAX_ITEMS = 64;

/** The scope of branch `index` of the parallel state's node execution `parallelNodeExecutionId`. */
export function branchScopeId(parallelNodeExecutionId: string, index: number): string {
    return `${parallelNodeExecutionId}#${index}`;
}

/** A branch scope's parallel node execution and index; null for the root scope (or any other text). */
export function parseBranchScope(scopeId: string): { parallelNodeExecutionId: string; index: number } | null {
    const match = /^(nx-[0-9a-f]+)#(0|[1-9]\d{0,5})$/.exec(scopeId);
    return match ? { parallelNodeExecutionId: match[1], index: Number(match[2]) } : null;
}

/**
 * Why the remaining branches of a parallel state were cancelled, as each
 * cancelled branch state's winner records it: another branch did not succeed
 * under failFast (`fail_fast`), the join had its successes (`join`), or the
 * state's own time limit passed (`join_timeout`).
 */
export const BRANCH_CANCEL_WINNERS = { failFast: "fail_fast", join: "join", timeout: "join_timeout" } as const;

export type BranchCancelReason = keyof typeof BRANCH_CANCEL_WINNERS;

/**
 * Workflow request and durable intake (design workflow-messaging-request.md
 * 8.2, workflow-durable-intake.md section 8): every activity of orchestration
 * 1.0.83's intake goes only to workers that declare this tag, so an older
 * worker never fetches work it cannot run. Every worker declares it
 * (WORKFLOW_MILESTONE_WORKER_TAGS, workflow/milestone-worker.ts).
 */
export const WORKFLOW_REQUEST_CAPABILITY = "pilotswarm.workflow-request.v1";

/** `stopped` (migration 0088): a run that ended by a graceful stop (requestRunStop, finishStoppedRun). */
export type WorkflowRunStatus = "admitted" | "running" | "paused" | "completed" | "failed" | "cancelled" | "stopped";

/** A run that has not ended: it can still be cancelled, deleted, recovered and finish its admitted work. */
export const ACTIVE_RUN_STATUSES: readonly WorkflowRunStatus[] = ["admitted", "running", "paused"];

/**
 * The one controller version (design workflow-messaging-request.md 8.1, 8.2). It reads its commands before every
 * admission, retries a run-ending write on durable timers, enters the workflow's catch-all state at most once per run by
 * any route (an unhandled runtime error of a script, or a terminal's invalid output, goes there while it has not run, and
 * any later route to it fails the run), waits while its run is paused (a refused admission of a paused run counts no
 * ordinal or step and is tried again after a resume), and runs wait states on its own durable timers. The store's clock
 * decides when a wait elapses: a wait the store does not find due yet (this worker's clock runs ahead of it) waits the
 * time the store reports. It runs messaging receive states (no effect orchestration; the store decides between a message
 * and the receive's wait, and a wake or the backstop collects it), send states (a send state admitted pending starts a
 * send orchestration that delivers its message and wakes the controller), request, agent and parallel states, test runs,
 * a run's deadline and a graceful stop. Every activity it schedules, and every activity of an orchestration it starts, is
 * scheduled with the workflow-request capability tag (WORKFLOW_ACTIVITIES), so a worker without that capability never
 * fetches that work.
 */
export const WORKFLOW_CONTROLLER_VERSION = "1.0.0";

export const WORKFLOW_EFFECT_NAME = "workflow-effect";

export const WORKFLOW_EFFECT_VERSION = "1.0.0";

/**
 * Delivers a messaging send state's message (one per node execution, with a
 * stable instance id): attempts with the run-ending writes' schedule, then
 * records that no delivery will be recorded, then wakes the controller.
 */
export const WORKFLOW_SEND_NAME = "workflow-send";

export const WORKFLOW_SEND_VERSION = "1.0.0";

/** Delivers a request state's request (one per node execution, stable instance id), then wakes the controller. */
export const WORKFLOW_REQUEST_NAME = "workflow-request";

export const WORKFLOW_REQUEST_VERSION = "1.0.0";

/** Creates an agent state's child agent session (one per node execution, stable instance id), then wakes the controller on a failure. */
export const WORKFLOW_AGENT_NAME = "workflow-agent";

export const WORKFLOW_AGENT_VERSION = "1.0.0";

/** Node admissions per controller execution before continue-as-new bounds history. */
export const WORKFLOW_ADMISSIONS_PER_EXECUTION = 25;

/**
 * Idle waits per controller execution before continue-as-new: each wait for a wake, a command or the backstop timer that
 * ended with no command (its timer, or a wake: a hint only), running or paused. Counted after a command is applied, so
 * the continue-as-new never drops one.
 */
export const WORKFLOW_IDLE_WAITS_PER_EXECUTION = 50;

/** A command read before an admission waits at most this long when the queue is empty (the session orchestration's idiom). */
export const WORKFLOW_COMMAND_POLL_MS = 10;

/**
 * The most messages one read of the command queue takes in a row (duroxide review DX-2): each one already queued is
 * taken at once, in the same turn, and duroxide 0.1.32 fails a turn whose orchestration resolves more than 100 of them in
 * a row (MAX_QUIESCENCE_ITERATIONS, replay_engine.rs). A read that reaches this many returns without a command, and the
 * pass's next store activity comes before the next read. Commands are store state (S7-DX2), so a read never needs more.
 */
export const WORKFLOW_COMMAND_READ_BATCH = 32;

/**
 * Attempts of a run-ending write (the finish and the parent notification).
 * Each attempt runs the activity with the store retry policy; attempts are
 * separated by these durable delays, so a store outage of about half an hour
 * still ends the run. After the last attempt the controller fails; its run
 * then shows needsRecovery, and update_workflow recover ends it
 * (recoverWorkflowRun). Nothing recovers it without that request.
 */
export const WORKFLOW_FINALIZE_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 600_000];

/** The arrival route of the workflow's catch-all state (not a valid route label, so it never collides with one). */
export const CATCH_ALL_ROUTE = "@catchAll";

export const ROOT_SCOPE = "root";

/** The arrival route of a parallel branch's first state (not a valid route label): its item, from the parallel state's manifest. */
export const BRANCH_ROUTE = "@branch";

/**
 * The activities of the controller and of the orchestrations it starts (design workflow-messaging-request.md 8.2), each
 * scheduled with the workflow-request capability tag: the store's writes and reads of a run, a script's run, a message's
 * and a request's delivery, a request's responder's observation, an agent state's child, a parallel state's branches and
 * join, a test run's interception, a run's deadline and its graceful stop.
 */
export const WORKFLOW_ACTIVITIES = {
    begin: "workflow.begin",
    plan: "workflow.plan",
    enter: "workflow.enter",
    collect: "workflow.collect",
    finish: "workflow.finish",
    cancel: "workflow.cancel",
    notifyParent: "workflow.notifyParent",
    elapse: "workflow.elapse",
    runScript: "workflow.runScript",
    recordEffectResult: "workflow.recordEffectResult",
    wake: "workflow.wake",
    deliver: "workflow.deliver",
    deliveryFailed: "workflow.deliveryFailed",
    observe: "workflow.observe",
    deliverRequest: "workflow.deliverRequest",
    requestDeliveryFailed: "workflow.requestDeliveryFailed",
    stop: "workflow.stop",
    spawnAgent: "workflow.spawnAgent",
    agentSpawnFailed: "workflow.agentSpawnFailed",
    endAgent: "workflow.endAgent",
    endAgents: "workflow.endAgents",
    endOwedAgentSession: "workflow.endOwedAgentSession",
    endOwedAgentSessionLast: "workflow.endOwedAgentSessionLast",
    endBranch: "workflow.endBranch",
    cancelBranches: "workflow.cancelBranches",
    join: "workflow.join",
    intercept: "workflow.intercept",
    expire: "workflow.expire",
    observeEnd: "workflow.observeEnd",
} as const;

export type WorkflowActivityKey = keyof typeof WORKFLOW_ACTIVITIES;

export function workflowEffectInstanceId(nodeExecutionId: string): string {
    return `wfx-${nodeExecutionId}`;
}

export function workflowSendInstanceId(nodeExecutionId: string): string {
    return `wfs-${nodeExecutionId}`;
}

export function workflowAgentInstanceId(nodeExecutionId: string): string {
    return `wfa-${nodeExecutionId}`;
}

export function workflowRequestInstanceId(nodeExecutionId: string): string {
    return `wfr-${nodeExecutionId}`;
}

/**
 * Durable delays between the attempts of one tagged store activity (five attempts). duroxide-node 0.2.4's retrying
 * activity cannot carry a tag (its task has no withTag), so the controller and the orchestrations it starts retry on
 * their own durable timers; an attempt has no timeout of its own. Exported, as WORKFLOW_FINALIZE_DELAYS_MS is, so a
 * fault test can compress the schedule in time only.
 */
export const WORKFLOW_STORE_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

export interface ControllerCursor {
    scopeId: string;
    nodeId: string;
    predecessorId: string | null;
    arrivalRoute: string | null;
    /** Node execution admitted for this cursor and not yet routed. */
    pending: string | null;
    /** The absolute deadline (epoch ms) of a pending wait state, fixed at its admission; null otherwise. */
    deadlineMs: number | null;
}

export interface ControllerState {
    irSha256: string;
    steps: number;
    ordinals: Record<string, number>;
    cursors: ControllerCursor[];
    /** The catch-all state was admitted (by any route); it is admitted at most once per run. */
    catchAllEntered: boolean;
    /** The parallel states whose branches run (absent: none). */
    parallels?: ControllerParallel[];
    /**
     * J1d: cut branches whose work's effect or child could not be stopped or ended yet, with why they
     * were cut; tried again at most once per backstop period, paused or not, busy or idle, and at the first pass after
     * continue-as-new (J1e), until none is owed (absent: none).
     */
    owedCuts?: ControllerOwedCut[];
}

/** A cut branch whose work's effect stop or child end is still owed (J1d), and why it was cut. */
export interface ControllerOwedCut {
    scopeId: string;
    reason: BranchCancelReason;
}

/**
 * A parallel state's branches, as the controller runs them: its node
 * execution (pending until the join), how many items its manifest has, the
 * next item without a branch, and how each branch that ended ended: the node
 * execution that ended it (its terminal, the state whose error had no route,
 * or the state a cancellation decided) or none (a branch that never started).
 */
export interface ControllerParallel {
    nodeExecutionId: string;
    /** The parallel state's id in the plan. */
    nodeId: string;
    total: number;
    nextIndex: number;
    results: Array<{ index: number; nodeExecutionId: string | null; via: "terminal" | "error" | "cancelled" | "not_started" }>;
    /**
     * No queued branch starts any more: the remaining branches were cancelled (failFast; the state was decided), or
     * the state's own time limit passed.
     */
    cancelled: boolean;
}

export interface ControllerInput {
    v: 1;
    workflowSessionId: string;
    runId: string;
    /** Set only by continue-as-new: the exact state the previous execution activated. */
    state?: ControllerState;
}

export interface ControllerPlan {
    name: string;
    version: string;
    initial: string;
    maxNodeExecutions: number;
    /** Recorded in history, so a changed worker default never alters a replay. */
    wakeBackstopMs: number;
    /** The state an unhandled runtime error (or a terminal's invalid output) routes to, once per run; null without one. */
    catchAll: string | null;
    /** A messaging state names its mode; no other state has one. */
    nodes: Record<string, {
        type: "script" | "wait" | "messaging" | "agent" | "parallel" | "terminal";
        mode?: "receive" | "send" | "request";
        next: Record<string, string>;
        /**
         * A parallel state's body initial, concurrency and failure policy, and `first`, the k of a
         * join of the first k successes (absent for a join of every branch), and `timeLimit` when it has its own time limit
         * (absent without one). With either, the store decides its join.
         */
        parallel?: { initial: string; concurrency: number; failFast: boolean; first?: number; timeLimit?: true;
            /**
             * A named fork: `branches`, its number of branches (the discriminator), with exactly one initial for each
             * (branch i starts at `initials[i]`) and each branch's states (`branchStates[i]`, which hold its initial). All three
             * are absent for a For each (review NB-R4).
             */
            branches?: number; initials?: string[]; branchStates?: string[][] };
    }>;
    /**
     * A test run: its agent, send and request states are intercepted (no child, delivery
     * or request exchange starts), and its deadlines run on its virtual clock. Absent for a live run.
     */
    test?: true;
    /**
     * A real-agent test run (with `test` only; design 05 agent mode real): its agent states are not intercepted. Each gets
     * its child as a live run's does, and is ended as a live run's is; the child's framework tool calls are intercepted in
     * its turns. Absent for every other run, so a plan recorded before it exists reads the same.
     */
    realAgents?: true;
    /**
     * A live run's deadline (limits.timeoutSeconds), as the store wrote it when the run
     * began: the controller wakes then to have the run expired. A test run's deadline is on its virtual clock and has none
     * here: its collection and admissions report it.
     */
    deadlineMs?: number;
}

export interface ControllerResult {
    runId: string;
    status: WorkflowRunStatus;
    outcome: string | null;
}

export interface CollectedResult {
    nodeExecutionId: string;
    outcome: string;
    resultKind: "business" | "runtime_error";
    /** A branch state its parallel state's join or time limit cancelled (winner join or join_timeout); its result goes nowhere. */
    cut?: true;
}

export class ControllerProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkflowControllerProtocolError";
    }
}

export function expect(condition: boolean, message: string): asserts condition {
    if (!condition) throw new ControllerProtocolError(message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown, what: string): Record<string, unknown> {
    expect(isRecord(value), `${what} is not an object`);
    return value;
}

export function text(value: unknown, what: string): string {
    expect(typeof value === "string", `${what} is not a string`);
    return value;
}

export function textOrNull(value: unknown, what: string): string | null {
    return value === null ? null : text(value, what);
}

export function isRunStatus(value: unknown): value is WorkflowRunStatus {
    return value === "admitted" || value === "running" || value === "paused" || value === "completed" || value === "failed" || value === "cancelled"
        || value === "stopped";
}

export function parseControllerInput(value: unknown): ControllerInput {
    const input = record(value, "controller input");
    expect(input.v === 1, "controller input version is not 1");
    const parsed: ControllerInput = { v: 1, workflowSessionId: text(input.workflowSessionId, "workflowSessionId"), runId: text(input.runId, "runId") };
    if (input.state !== undefined) parsed.state = parseControllerState(input.state);
    return parsed;
}

export function parseControllerState(value: unknown): ControllerState {
    const state = record(value, "controller state");
    const ordinals = record(state.ordinals, "ordinals");
    expect(Array.isArray(state.cursors), "cursors is not a list");
    expect(typeof state.steps === "number", "steps is not a number");
    const parsedOrdinals: Record<string, number> = {};
    for (const [key, ordinal] of Object.entries(ordinals)) {
        expect(typeof ordinal === "number" && Number.isSafeInteger(ordinal), `ordinal ${key} is invalid`);
        parsedOrdinals[key] = ordinal;
    }
    expect(state.catchAllEntered === undefined || typeof state.catchAllEntered === "boolean", "catchAllEntered is not a boolean");
    expect(state.parallels === undefined || Array.isArray(state.parallels), "parallels is not a list");
    const parallels = state.parallels === undefined ? undefined : (state.parallels as unknown[]).map((raw, index) => {
        const item = record(raw, `parallel ${index}`);
        const count = (value: unknown, what: string) => { expect(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `parallel ${index} ${what} is invalid`); return value as number; };
        expect(Array.isArray(item.results) && typeof item.cancelled === "boolean", `parallel ${index} is invalid`);
        return {
            nodeExecutionId: text(item.nodeExecutionId, "nodeExecutionId"), nodeId: text(item.nodeId, "nodeId"),
            total: count(item.total, "total"), nextIndex: count(item.nextIndex, "nextIndex"),
            results: (item.results as unknown[]).map((rawResult, at) => {
                const result = record(rawResult, `parallel ${index} result ${at}`);
                expect(result.via === "terminal" || result.via === "error" || result.via === "cancelled" || result.via === "not_started",
                    `parallel ${index} result ${at} is invalid`);
                return { index: count(result.index, "result index"), nodeExecutionId: textOrNull(result.nodeExecutionId, "nodeExecutionId"),
                    via: result.via as ControllerParallel["results"][number]["via"] };
            }),
            cancelled: item.cancelled as boolean,
        };
    });
    expect(state.owedCuts === undefined || Array.isArray(state.owedCuts), "owedCuts is not a list");
    const owedCuts = state.owedCuts === undefined ? undefined : (state.owedCuts as unknown[]).map((raw, index) => {
        const item = record(raw, `owed cut ${index}`);
        expect(item.reason === "failFast" || item.reason === "join" || item.reason === "timeout", `owed cut ${index} reason is invalid`);
        return { scopeId: text(item.scopeId, "scopeId"), reason: item.reason as BranchCancelReason };
    });
    return {
        irSha256: text(state.irSha256, "irSha256"),
        steps: state.steps,
        ordinals: parsedOrdinals,
        catchAllEntered: state.catchAllEntered === true,
        ...(parallels !== undefined ? { parallels } : {}),
        ...(owedCuts !== undefined ? { owedCuts } : {}),
        cursors: state.cursors.map((cursor, index) => {
            const item = record(cursor, `cursor ${index}`);
            const deadlineMs = item.deadlineMs === undefined || item.deadlineMs === null ? null : item.deadlineMs;
            expect(deadlineMs === null || (typeof deadlineMs === "number" && Number.isSafeInteger(deadlineMs)), `cursor ${index} deadline is invalid`);
            return {
                scopeId: text(item.scopeId, "scopeId"), nodeId: text(item.nodeId, "nodeId"),
                predecessorId: textOrNull(item.predecessorId, "predecessorId"), arrivalRoute: textOrNull(item.arrivalRoute, "arrivalRoute"),
                pending: textOrNull(item.pending, "pending"), deadlineMs,
            };
        }),
    };
}

/**
 * The state a parallel branch starts at: the body's initial (a For each), or its named branch's own. A plan whose
 * initials are not one for each branch (one manifest item each) fails loudly rather than starting the first branch's.
 */
export function parallelBranchInitial(spec: { initial: string; initials?: string[]; branches?: number }, index: number, total: number): string {
    expect(spec.branches === undefined || (spec.initials !== undefined && spec.branches === total),
        `the plan's named fork has ${spec.branches} branches and ${spec.initials?.length ?? "no"} initials for ${total} branches`);
    if (spec.initials === undefined) return spec.initial;
    expect(spec.initials.length === total && Number.isSafeInteger(index) && index >= 0 && index < total,
        `the plan has ${spec.initials.length} branch initials for ${total} branches (branch ${index})`);
    return spec.initials[index];
}

/**
 * Review NB-R4: a parallel plan node's named-fork fields. A For each has none of them. A named fork gives its
 * number of branches, exactly one initial for each, the first the body's, and each branch's states, which hold its initial
 * and are nodes of the plan.
 */
export function namedForkValid(parallel: Record<string, unknown>, nodes: Record<string, unknown>): boolean {
    if (parallel.branches === undefined) return parallel.initials === undefined && parallel.branchStates === undefined;
    const count = parallel.branches;
    const { initials, branchStates } = parallel;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || !Array.isArray(initials) || !Array.isArray(branchStates)) return false;
    if (initials.length !== count || branchStates.length !== count || initials[0] !== parallel.initial) return false;
    return initials.every((initial, index) => {
        const states = branchStates[index];
        return typeof initial === "string" && Array.isArray(states) && states.length > 0
            && states.every(state => typeof state === "string" && Object.hasOwn(nodes, state)) && states.includes(initial);
    });
}

/** A controller's plan. */
export function parsePlan(value: unknown): ControllerPlan {
    const plan = record(value, "plan");
    const nodes = record(plan.nodes, "plan nodes");
    expect(typeof plan.maxNodeExecutions === "number", "plan limit is invalid");
    expect(typeof plan.wakeBackstopMs === "number" && Number.isSafeInteger(plan.wakeBackstopMs) && plan.wakeBackstopMs >= 100,
        "plan wake backstop is invalid");
    const parsed: ControllerPlan["nodes"] = {};
    for (const [id, node] of Object.entries(nodes)) {
        const item = record(node, `plan node ${id}`);
        expect(item.type === "script" || item.type === "wait" || item.type === "messaging" || item.type === "terminal"
            || item.type === "agent" || item.type === "parallel", `plan node ${id} type is invalid`);
        expect(item.type === "messaging" ? item.mode === "receive" || item.mode === "send" || item.mode === "request" : item.mode === undefined,
            `plan node ${id} mode is invalid`);
        const next = record(item.next, `plan node ${id} next`);
        const routes: Record<string, string> = {};
        for (const [label, target] of Object.entries(next)) routes[label] = text(target, `route ${label}`);
        if (item.type === "parallel") {
            const parallel = record(item.parallel, `plan node ${id} parallel`);
            expect(typeof parallel.concurrency === "number" && Number.isSafeInteger(parallel.concurrency) && parallel.concurrency >= 1
                && typeof parallel.failFast === "boolean"
                && (parallel.first === undefined || (typeof parallel.first === "number" && Number.isSafeInteger(parallel.first) && parallel.first >= 1))
                && (parallel.timeLimit === undefined || parallel.timeLimit === true)
                && namedForkValid(parallel, nodes),
            `plan node ${id} parallel is invalid`);
            parsed[id] = { type: "parallel", next: routes,
                parallel: { initial: text(parallel.initial, "parallel initial"), concurrency: parallel.concurrency, failFast: parallel.failFast,
                    ...(typeof parallel.first === "number" ? { first: parallel.first } : {}), ...(parallel.timeLimit === true ? { timeLimit: true as const } : {}),
                    ...(typeof parallel.branches === "number" ? { branches: parallel.branches, initials: [...parallel.initials as string[]],
                        branchStates: (parallel.branchStates as string[][]).map(states => [...states]) } : {}) } };
            continue;
        }
        parsed[id] = item.type === "messaging"
            ? { type: item.type, mode: item.mode === "send" ? "send" : item.mode === "request" ? "request" : "receive", next: routes }
            : { type: item.type, next: routes };
    }
    const catchAll = plan.catchAll === undefined ? null : textOrNull(plan.catchAll, "catchAll");
    expect(catchAll === null || Object.hasOwn(parsed, catchAll), "plan catch-all state is missing");
    expect(plan.test === undefined || plan.test === true, "plan test flag is invalid");
    expect(plan.realAgents === undefined || (plan.test === true && plan.realAgents === true), "plan real-agent flag is invalid");
    expect(plan.deadlineMs === undefined || (typeof plan.deadlineMs === "number" && Number.isSafeInteger(plan.deadlineMs) && plan.deadlineMs > 0),
        "plan deadline is invalid");
    return {
        name: text(plan.name, "name"), version: text(plan.version, "version"), initial: text(plan.initial, "initial"),
        maxNodeExecutions: plan.maxNodeExecutions, wakeBackstopMs: plan.wakeBackstopMs, catchAll, nodes: parsed,
        ...(plan.test === true ? { test: true as const } : {}),
        ...(plan.realAgents === true ? { realAgents: true as const } : {}),
        ...(typeof plan.deadlineMs === "number" ? { deadlineMs: plan.deadlineMs } : {}),
    };
}

/** The orchestration's deterministic current time (epoch ms). */
export function parseNow(value: unknown): number {
    const now = typeof value === "string" ? Number(value) : value;
    expect(typeof now === "number" && Number.isSafeInteger(now) && now > 0, "utcNow result is invalid");
    return now;
}

export function parseRace(value: unknown): { index: number; value: unknown } {
    const raced = record(value, "race result");
    expect(raced.index === 0 || raced.index === 1, "race index is invalid");
    return { index: raced.index, value: raced.value };
}

export function parseBegin(value: unknown): { status: WorkflowRunStatus; irSha256: string; initial: string; outcome: string | null } {
    const begun = record(value, "begin result");
    expect(isRunStatus(begun.status), "begin status is invalid");
    return { status: begun.status, irSha256: text(begun.irSha256, "irSha256"), initial: text(begun.initial, "initial"), outcome: textOrNull(begun.outcome, "outcome") };
}

/** A stop's deadline in the store's clock (epoch ms), as the enter and collect activities report it. */
export function parseStopping(value: unknown, what: string): { deadlineMs: number } | null {
    if (value === undefined || value === null) return null;
    const stopping = record(value, what);
    expect(typeof stopping.deadlineMs === "number" && Number.isSafeInteger(stopping.deadlineMs) && stopping.deadlineMs > 0, `${what} deadline is invalid`);
    return { deadlineMs: stopping.deadlineMs };
}

/**
 * An enter result. A refused admission of a run with an accepted stop
 * carries the stop's deadline (`stopping`).
 */
export function parseEnter(value: unknown): { admitted: true; nodeExecutionId: string; state: "pending" | "completed"; deadlineMs: number | null; branches: number | null }
    | { admitted: false; status: WorkflowRunStatus; outcome: string | null; stopping: { deadlineMs: number } | null; expired: boolean; cut: boolean } {
    const entered = record(value, "enter result");
    if (entered.admitted === false) {
        expect(isRunStatus(entered.status), "enter status is invalid");
        expect(entered.expired === undefined || entered.expired === true, "enter expiry is invalid");
        expect(entered.cut === undefined || entered.cut === true, "enter cut is invalid");
        return { admitted: false, status: entered.status, outcome: textOrNull(entered.outcome, "outcome"), stopping: parseStopping(entered.stopping, "enter stopping"),
            expired: entered.expired === true, cut: entered.cut === true };
    }
    expect(entered.admitted === true, "enter result is invalid");
    expect(entered.state === "pending" || entered.state === "completed", "enter state is invalid");
    const deadlineMs = entered.deadlineMs === undefined || entered.deadlineMs === null ? null : entered.deadlineMs;
    expect(deadlineMs === null || (typeof deadlineMs === "number" && Number.isSafeInteger(deadlineMs)), "enter deadline is invalid");
    const branches = entered.branches === undefined || entered.branches === null ? null : entered.branches;
    expect(branches === null || (typeof branches === "number" && Number.isSafeInteger(branches) && branches >= 0 && branches <= WORKFLOW_PARALLEL_MAX_ITEMS),
        "enter branches is invalid");
    return { admitted: true, nodeExecutionId: text(entered.nodeExecutionId, "nodeExecutionId"), state: entered.state, deadlineMs, branches };
}

/** The waits the store did not find due yet, with the milliseconds it reported left (at least 1). */
export function parseElapse(value: unknown): Array<{ nodeExecutionId: string; remainingMs: number }> {
    const elapsed = record(value, "elapse result");
    expect(Array.isArray(elapsed.notDue), "elapse result is invalid");
    return elapsed.notDue.map((item, index) => {
        const wait = record(item, `not-due wait ${index}`);
        expect(typeof wait.remainingMs === "number" && Number.isSafeInteger(wait.remainingMs) && wait.remainingMs >= 1, `not-due wait ${index} is invalid`);
        return { nodeExecutionId: text(wait.nodeExecutionId, "nodeExecutionId"), remainingMs: wait.remainingMs };
    });
}

/**
 * The collect result: the stored results, and, read after them, the run's accepted stop (its deadline),
 * whether it is past its deadline, and whether it is paused (adversarial review R2-RT-1; a result recorded before that
 * field existed says not paused, as its controller then read it).
 */
export function parseCollectedWithStop(value: unknown): { collected: CollectedResult[]; stopping: { deadlineMs: number } | null; expired: boolean; paused: boolean;
    ended: boolean } {
    const result = record(value, "collect result");
    expect(result.expired === undefined || result.expired === true, "collect expiry is invalid");
    expect(result.paused === undefined || result.paused === true, "collect pause is invalid");
    expect(result.ended === undefined || result.ended === true, "collect end is invalid");
    return { collected: parseCollected(result.collected), stopping: parseStopping(result.stopping, "collect stopping"), expired: result.expired === true,
        paused: result.paused === true, ended: result.ended === true };
}

/**
 * The expire activity's answer: the run ended (`expired` when its deadline ended it,
 * false when another end came first), or the time its clock has left (at least 1 ms).
 */
export function parseExpire(value: unknown): { ended: true; expired: boolean; result: ControllerResult } | { ended: false; remainingMs: number } {
    const expiry = record(value, "expire result");
    if (expiry.ended === false) {
        expect(typeof expiry.remainingMs === "number" && Number.isSafeInteger(expiry.remainingMs) && expiry.remainingMs >= 1, "expire time left is invalid");
        return { ended: false, remainingMs: expiry.remainingMs };
    }
    expect(expiry.ended === true && typeof expiry.expired === "boolean", "expire result is invalid");
    return { ended: true, expired: expiry.expired, result: parseResult(expiry.result) };
}

/** The stop activity's answer: the run ended (by this stop, or by an end that came first), or the store's time left. */
export function parseStopFinish(value: unknown): { ended: true; result: ControllerResult } | { ended: false; remainingMs: number } {
    const finished = record(value, "stop result");
    if (finished.ended === false) {
        expect(typeof finished.remainingMs === "number" && Number.isSafeInteger(finished.remainingMs) && finished.remainingMs >= 1, "stop time left is invalid");
        return { ended: false, remainingMs: finished.remainingMs };
    }
    expect(finished.ended === true, "stop result is invalid");
    return { ended: true, result: parseResult(finished.result) };
}

export function parseCollected(value: unknown): CollectedResult[] {
    expect(Array.isArray(value), "collect result is not a list");
    return value.map((item, index) => {
        const result = record(item, `collected ${index}`);
        expect(result.resultKind === "business" || result.resultKind === "runtime_error", "collected kind is invalid");
        expect(result.cut === undefined || result.cut === true, "collected cut is invalid");
        return { nodeExecutionId: text(result.nodeExecutionId, "nodeExecutionId"), outcome: text(result.outcome, "outcome"), resultKind: result.resultKind,
            ...(result.cut === true ? { cut: true as const } : {}) };
    });
}

export function parseResult(value: unknown): ControllerResult {
    const result = record(value, "controller result");
    expect(isRunStatus(result.status), "result status is invalid");
    return { runId: text(result.runId, "runId"), status: result.status, outcome: textOrNull(result.outcome, "outcome") };
}

/** observeEnd's answer: the ended run, and whether the end is its workflow's deletion. */
export function parseObservedEnd(value: unknown): ControllerResult & { deleted: boolean } {
    const observed = record(value, "observed end");
    const deleted = observed.deleted === true;
    expect(deleted || observed.deleted === false, "observed deletion is invalid");
    return { ...parseResult(observed), deleted };
}

/**
 * A run-ending activity's answer (finish, cancel): the run's result, and whether another writer had ended the run first
 * (S7-DX3, N-1, N-2: `elsewhere`; an answer recorded before that field says not).
 */
export function parseEndResult(value: unknown): { result: ControllerResult; elsewhere: boolean } {
    const ended = record(value, "end result");
    expect(ended.elsewhere === undefined || ended.elsewhere === true, "end result elsewhere is invalid");
    return { result: parseResult(value), elsewhere: ended.elsewhere === true };
}

/**
 * The finish of a terminal state: the run ended (or had already ended), or
 * the terminal's output failed its contract and the error goes to the
 * catch-all state instead (only when the controller offered that route).
 */
export function parseTerminalFinish(value: unknown): { routed: false; result: ControllerResult; elsewhere: boolean } | { routed: true; nodeExecutionId: string; code: string } {
    const finished = record(value, "finish result");
    if (finished.routed === undefined) return { routed: false, ...parseEndResult(value) };
    const routed = record(finished.routed, "finish route");
    return { routed: true, nodeExecutionId: text(routed.nodeExecutionId, "nodeExecutionId"), code: text(routed.code, "code") };
}

/**
 * The answer of the join of a parallel state that the store decides (a join of the first k, a time limit or named branches): decided (now or before), with why its
 * controller cuts the branches still running, or not yet.
 */
export function parseJoinAnswer(value: unknown): { decided: true; cut: BranchCancelReason } | { decided: false } {
    const answer = record(value, "join result");
    if (answer.decided === false) return { decided: false };
    expect(answer.decided === true && (answer.cut === "join" || answer.cut === "timeout" || answer.cut === "failFast"), "join result is invalid");
    return { decided: true, cut: answer.cut };
}

/**
 * The answer of the cancellation of cut branches: the branches whose work's effect or child could not
 * be stopped or ended yet (J1d; none in an answer recorded before J1d, whose activity failed instead while any was owed).
 */
export function parseBranchCancel(value: unknown): { owedScopeIds: string[] } {
    const answer = record(value, "cancel branches result");
    if (answer.owedScopeIds === undefined) return { owedScopeIds: [] };
    expect(Array.isArray(answer.owedScopeIds), "owedScopeIds is not a list");
    return { owedScopeIds: answer.owedScopeIds.map((id, index) => text(id, `owedScopeIds[${index}]`)) };
}

/** The route a stored result takes: its business outcome, or its error code, or the failure catch; null when unhandled. */
export function selectRoute(next: Record<string, string>, result: { outcome: string; resultKind: "business" | "runtime_error" }): string | null {
    if (result.resultKind === "business") return Object.hasOwn(next, result.outcome) ? result.outcome : null;
    if (Object.hasOwn(next, result.outcome)) return result.outcome;
    return Object.hasOwn(next, FAILURE_ROUTE) ? FAILURE_ROUTE : null;
}
