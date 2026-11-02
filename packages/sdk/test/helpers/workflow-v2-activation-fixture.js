import { createRequire } from "node:module";
import { expect, vi } from "vitest";
import { intakeActivityFixture } from "./workflow-v2-intake-activities-fixture.js";
import {
    AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY, TURN_CONTROL_CAPABILITY, WORKFLOW_REQUEST_CAPABILITY, routeWorkflowRequestActivity,
} from "../../src/activity-routing.ts";
import { WORKFLOW_INTAKE_ACTIVITIES } from "../../src/workflow/v2/intake.ts";
import { registerWorkflowIntakeActivities } from "../../src/workflow/v2/intake-activities.ts";
import { durableSessionOrchestration_1_0_82 } from "../../src/orchestration_1_0_82/index.ts";
import { DURABLE_SESSION_ORCHESTRATION_NAME } from "../../src/orchestration-registry.ts";

const { PostgresProvider, Runtime, Client } = createRequire(import.meta.url)("duroxide");
const LEGACY_TAGS = [AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY, TURN_CONTROL_CAPABILITY];
export const ACTIVATION_SLICE_TIMEOUT = 180_000;
export const ACTIVITY_FENCE_ORCHESTRATION = "workflow-activity-fence-fixture";
export const UNTAGGED_CONTROL_ORCHESTRATION = "workflow-activity-fence-control";

/** Custom orchestration only for activity routing: both runtimes understand it, and real store handlers do its work. */
function* activityFence(ctx, claimInput) {
    const claimed = yield routeWorkflowRequestActivity(ctx.scheduleActivity(WORKFLOW_INTAKE_ACTIVITIES.claim, claimInput));
    if (!claimed.ok || claimed.result.result !== "accepted") throw new Error("The routing fixture's real claim was not accepted.");
    const settled = yield routeWorkflowRequestActivity(ctx.scheduleActivity(WORKFLOW_INTAKE_ACTIVITIES.settle, {
        op: "cancel_held", recipientSessionId: claimInput.recipientSessionId,
        items: [{ exchangeId: claimInput.envelope.exchangeId, claimId: claimInput.claimId }],
    }));
    return { claimed, settled };
}

export function scheduledActivities(history, name) {
    const prefix = `{"name":${JSON.stringify(name)}`;
    return history.filter(event => event.kind === "ActivityScheduled" && String(event.data).startsWith(prefix));
}

function errorDetails(error) {
    return error instanceof Error ? { name: error.name, message: error.message, code: error.code, stack: error.stack }
        : { thrown: String(error) };
}

function readOutcome(result) {
    return result.status === "fulfilled" ? { ok: true, value: result.value } : { ok: false, error: errorDetails(result.reason) };
}

/** Capture only this fixture's history and events while its clients and randomized schemas still exist. */
async function boundaryFailure(h, instanceId, label, sessionId, last, cause) {
    const sessionIds = [...new Set([sessionId, h.workflowSessionId, h.recipientSessionId])];
    const reads = await Promise.allSettled([
        h.client.getInstanceInfo(instanceId), h.client.getStatus(instanceId), h.client.listExecutions(instanceId),
        ...sessionIds.map(id => h.catalog.getSessionEvents(id, 0, 1000)),
    ]);
    const executions = reads[2];
    let histories;
    if (executions.status === "fulfilled" && Array.isArray(executions.value)) {
        const results = await Promise.allSettled(executions.value.map(id => h.client.readExecutionHistory(instanceId, id)));
        histories = results.map((result, index) => ({ executionId: executions.value[index], ...readOutcome(result) }));
    } else {
        histories = { notRead: "listExecutions did not return an execution list", executions: readOutcome(executions) };
    }
    const snapshot = {
        boundary: label, instanceId, cause: errorDetails(cause), lastObservation: last,
        finalReads: { info: readOutcome(reads[0]), status: readOutcome(reads[1]), executions: readOutcome(executions), histories },
        calls: [...h.calls],
        cmsEvents: sessionIds.map((id, index) => ({ sessionId: id, ...readOutcome(reads[index + 3]) })),
    };
    console.info("workflow activation native boundary failure", JSON.stringify(snapshot));
    const failure = new Error(`Native boundary "${label}" failed: ${String(cause.message ?? cause)}`, { cause });
    failure.name = "NativeBoundaryError";
    failure.boundarySnapshot = snapshot;
    return failure;
}

/** Condition on persisted native history, not on callback entry or an arbitrary elapsed interval. */
export async function nativeBoundary(h, instanceId, label, check, sessionId = h.workflowSessionId, timeout = 45_000) {
    let observed;
    const last = { attempts: 0, readPhase: "not started", info: null, status: null, history: null, historyExecutionId: null,
        predicateParts: null, readError: null };
    try {
        await vi.waitFor(async () => {
            last.attempts += 1;
            last.readError = null;
            try {
                last.readPhase = "getInstanceInfo";
                const info = await h.client.getInstanceInfo(instanceId);
                last.info = info;
                last.readPhase = "readExecutionHistory";
                const history = await h.client.readExecutionHistory(instanceId, info.currentExecutionId);
                last.history = history;
                last.historyExecutionId = info.currentExecutionId;
                last.readPhase = "getStatus";
                const status = await h.client.getStatus(instanceId);
                last.status = status;
                last.readPhase = "predicate";
                last.predicateParts = check({ info, history, status });
                expect(status.status, `${label}: ${JSON.stringify(status)}`).not.toBe("Failed");
                expect(Object.values(last.predicateParts).every(part => part === true), `${label}: ${JSON.stringify(last.predicateParts)}`).toBe(true);
                observed = { info, history, status };
            } catch (error) {
                last.readError = errorDetails(error);
                throw error;
            }
        }, { timeout, interval: 50 });
    } catch (cause) {
        throw await boundaryFailure(h, instanceId, label, sessionId, last, cause);
    }
    return observed;
}

/** All runtimes share this one disposable PostgreSQL provider/schema; only runtime handles are replaced. */
export async function activationFixture(env) {
    const intake = await intakeActivityFixture(env);
    const runtimes = new Set();
    const calls = [];
    try {
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const runtime = (label, tags) => {
            const worker = new Runtime(provider, {
                workerNodeId: `${env.runId}-${label}`, workerConcurrency: 2, orchestrationConcurrency: 1,
                dispatcherPollIntervalMs: 20, workerLockTimeoutMs: 10_000, sessionIdleTimeoutMs: 3_600_000,
                workerTagFilter: { defaultAnd: tags }, logLevel: "error",
            });
            runtimes.add(worker);
            return worker;
        };
        const stop = async worker => {
            await worker.shutdown(3_000);
            runtimes.delete(worker);
        };
        const stopAll = async () => {
            const results = await Promise.allSettled([...runtimes].reverse().map(stop));
            const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
            if (failures.length > 0) throw new AggregateError(failures, "Activation fixture runtimes did not all shut down.");
        };
        const activityWorker = (label, capable) => {
            const worker = runtime(label, capable ? [...LEGACY_TAGS, WORKFLOW_REQUEST_CAPABILITY] : LEGACY_TAGS);
            worker.registerOrchestration(ACTIVITY_FENCE_ORCHESTRATION, activityFence);
            worker.registerOrchestration(UNTAGGED_CONTROL_ORCHESTRATION, function* (ctx) {
                return yield ctx.scheduleActivity("activationUntaggedControl", {});
            });
            worker.registerActivity("activationUntaggedControl", async ctx => {
                calls.push({ worker: label, name: "activationUntaggedControl", tag: ctx.tag() });
                return { worker: label };
            });
            if (capable) {
                registerWorkflowIntakeActivities({
                    registerActivity(name, handler) {
                        worker.registerActivity(name, async (ctx, input) => {
                            calls.push({ worker: label, name, tag: ctx.tag() });
                            return handler(ctx, input);
                        });
                    },
                }, intake.deps);
            } else {
                for (const name of Object.values(WORKFLOW_INTAKE_ACTIVITIES)) {
                    worker.registerActivity(name, async ctx => {
                        calls.push({ worker: label, name, tag: ctx.tag() });
                        throw new Error(`An incapable worker fetched protected activity ${name}.`);
                    });
                }
            }
            return worker;
        };
        /** Actual frozen handler and native history; policy is controlled, event/stat leaves use the real stores. No turn is dispatched. */
        const historical82Worker = label => {
            const worker = runtime(label, LEGACY_TAGS);
            worker.registerOrchestrationVersioned(DURABLE_SESSION_ORCHESTRATION_NAME, "1.0.82", durableSessionOrchestration_1_0_82);
            worker.registerActivity("getWorkerSessionPolicy", async () => {
                calls.push({ worker: label, name: "getWorkerSessionPolicy" });
                return { policy: null, allowedAgentNames: [] };
            });
            worker.registerActivity("recordSessionEvent", async (_ctx, input) => {
                calls.push({ worker: label, name: "recordSessionEvent", events: input.events });
                await intake.catalog.recordEvents(input.sessionId, input.events, `${env.runId}-${label}`);
                return null;
            });
            worker.registerActivity("getOrchestrationStats", async (_ctx, input) => {
                calls.push({ worker: label, name: "getOrchestrationStats" });
                return client.getOrchestrationStats(`session-${input.sessionId}`);
            });
            return worker;
        };
        return {
            ...intake, provider, client, calls, activityWorker, historical82Worker, stop,
            async close() {
                try { await stopAll(); } finally { await intake.close(); }
            },
        };
    } catch (error) {
        const stopped = await Promise.allSettled([...runtimes].reverse().map(worker => worker.shutdown(3_000)));
        try { await intake.close(); } finally {
            const failures = stopped.filter(result => result.status === "rejected").map(result => result.reason);
            if (failures.length > 0) throw new AggregateError([error, ...failures], "Activation fixture setup and shutdown failed.");
        }
        throw error;
    }
}
