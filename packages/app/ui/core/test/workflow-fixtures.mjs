// Fixtures for the workflow view tests. Every shape below is copied from the
// writers, not invented:
//  - states: describeWorkflowState, packages/sdk/src/workflow/runtime.ts (1122-1149)
//  - events: runtime.ts (workflow.started 1345, state_started 1475, state_failed 1026/1564/1647, state_completed 1048/1790/1876)
//    and store.ts (state_completed for receive 2205 and 2482, paused/resumed 1644)
//  - read model: readWorkflowView, packages/sdk/src/workflow/tools.ts (304-365)

export const RUN = "run-1";

/** The reason a person is given for a workflow started by another workflow's agent step (human-commands.ts), as the server words it. */
export const SUBTREE_REASON = "This workflow was started by an agent step of another workflow: people can pause, stop or cancel it; only its controlling "
    + "agent changes, resumes or tests it.";

/** A person's commands for such a workflow, as its read model reports them (personCommands); `run` is the run shown, or null. */
export const subtreeCommands = (run = { runId: RUN, stop: true }) => ({
    operations: ["pause", "stop", "cancel"],
    restriction: { reason: SUBTREE_REASON, workflowSessionId: "wf-container", controllingSessionId: "parent-agent" },
    run,
});

export const states = [
    { id: "poll", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["changed", "unchanged"],
        next: { changed: "notify", unchanged: "pause", failure: "failed", timed_out: "failed" } },
    { id: "pause", type: "wait", seconds: 30, outcomes: ["elapsed"], next: { elapsed: "poll" } },
    { id: "notify", type: "messaging", mode: "send", contract: "Alert@1", recipient: "parent", outcomes: ["sent"],
        next: { sent: "await_ack", delivery_failed: "failed" } },
    { id: "await_ack", type: "messaging", mode: "receive", contract: "Ack@1", from: "parent", waitSeconds: 600,
        outcomes: ["received", "elapsed"], next: { received: "done", elapsed: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];

export const requestStates = [
    { id: "ask", type: "messaging", mode: "request", contract: "Review@1", recipient: "reviewer-1", timeoutSeconds: 120,
        outcomes: ["responded", "declined"], next: { responded: "done", declined: "done", timed_out: "failed" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];

export const startedData = {
    runId: RUN, mode: "live", revision: 1, definitionHash: "hash-1", irSha256: "ir-1",
    name: "watch-flow", version: "1.0.0", initial: "poll", states,
};

export const ev = (eventType, data) => ({ eventType, data });
const nx = (stateId, step) => `nx-${stateId}-${step}`;

export const started = (stateId, step, extra = {}) => ev("workflow.state_started", {
    runId: RUN, nodeExecutionId: nx(stateId, step), stateId, scopeId: "root", ordinal: step, type: "script", step, kvRevision: 1, ...extra });
export const completed = (stateId, step, outcome, outputPreview, extra = {}) => ev("workflow.state_completed", {
    runId: RUN, nodeExecutionId: nx(stateId, step), stateId, step, outcome, resultKind: "business",
    ...(outputPreview === undefined ? {} : { outputPreview }), ...extra });
export const runtimeError = (stateId, step, code, error) => ev("workflow.state_failed", {
    runId: RUN, nodeExecutionId: nx(stateId, step), stateId, step, outcome: code, resultKind: "runtime_error", error });
export const ended = (type, data = {}) => ev(type, { runId: RUN, name: "watch-flow", ...data });

export const row = (stateId, ordinal, state, extra = {}) => ({
    nodeExecutionId: nx(stateId, ordinal), stateId, ordinal, state, outcome: null, resultKind: null, winner: null, attempts: 0, kvRevision: 1, ...extra });
export const done = (stateId, ordinal, outcome, extra = {}) => row(stateId, ordinal, "completed",
    { outcome, resultKind: "business", winner: "controller", ...extra });

export function readModel({ run = {}, nodeExecutions = [], inbox = [], outbox = [], revision = {}, definition = {}, graph, runs, noRun = false } = {}) {
    const status = run.status ?? "running";
    const model = {
        workflowId: "wf-1",
        definition: { state: "published", semver: "1.0.0", currentRevision: 1, publishedRevision: 1, publishedDefinitionHash: "hash-1", ...definition },
        revision: { revision: 1, definitionHash: "hash-1", valid: true, irSha256: "ir-1", name: "watch-flow", diagnostics: [], ...revision },
        graph: graph === undefined ? { revision: 1, initial: "poll", states } : graph,
        runs: runs ?? (noRun ? [] : [{ runId: RUN, mode: run.mode ?? "live", status, revision: 1, outcome: run.outcome ?? null }]),
        run: noRun ? null : { runId: RUN, mode: "live", status, outcome: null, terminalState: null, output: null, error: null,
            kvRevision: 1, kv: "{}", nodeExecutions, inbox, outbox, ...run },
    };
    // A server lists test runs only while its test mode is on, and then says so (review UI-5): a fixture with a test run
    // is such a server's read.
    if (model.runs.some(item => item?.mode === "test") || model.run?.mode === "test") model.testMode = true;
    return model;
}
