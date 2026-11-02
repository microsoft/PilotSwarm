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

/** Condition on persisted native history, not on callback entry or an arbitrary elapsed interval. */
export async function nativeBoundary(client, instanceId, check, timeout = 45_000) {
    let observed;
    await vi.waitFor(async () => {
        let info;
        try { info = await client.getInstanceInfo(instanceId); } catch (error) {
            if (String(error.message).includes("Instance not found")) throw new Error("The native instance has not been created yet.");
            throw error;
        }
        const history = await client.readExecutionHistory(instanceId, info.currentExecutionId);
        const status = await client.getStatus(instanceId);
        expect(status.status, JSON.stringify(status)).not.toBe("Failed");
        expect(check({ info, history, status })).toBe(true);
        observed = { info, history, status };
    }, { timeout, interval: 50 });
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
