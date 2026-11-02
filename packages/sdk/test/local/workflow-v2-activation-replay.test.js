import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import {
    activationFixture, nativeBoundary, scheduledActivities, ACTIVATION_SLICE_TIMEOUT,
    ACTIVITY_FENCE_ORCHESTRATION, UNTAGGED_CONTROL_ORCHESTRATION,
} from "../helpers/workflow-v2-activation-fixture.js";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { WORKFLOW_INTAKE_ACTIVITIES } from "../../src/workflow/v2/intake.ts";
import { DURABLE_SESSION_ORCHESTRATION_NAME } from "../../src/orchestration-registry.ts";

const getEnv = useSuiteEnv(import.meta.url);

describe("workflow v2 activation first native slice (no activation)", () => {
    it("activity fence only: old traps cannot claim tagged intake work, which completes when a capable worker joins", { timeout: ACTIVATION_SLICE_TIMEOUT }, async () => {
        const h = await activationFixture(getEnv());
        try {
            const input = await h.send(1);
            const effects = await h.effects();
            const old = h.activityWorker("old", false);
            await old.start();
            await h.client.startOrchestration("protected-intake", ACTIVITY_FENCE_ORCHESTRATION, input);
            const pending = await nativeBoundary(h, "protected-intake", "activity claim scheduled before capable worker", ({ history }) => ({
                exactlyOneClaimScheduled: scheduledActivities(history, WORKFLOW_INTAKE_ACTIVITIES.claim).length === 1,
            }));
            expect(pending.status.status).toBe("Running");
            // A completed untagged operation proves the old native worker is serving this same queue, without sleeping as evidence.
            await h.client.startOrchestration("old-positive-control", UNTAGGED_CONTROL_ORCHESTRATION, {});
            expect(await h.client.waitForOrchestration("old-positive-control", 15_000))
                .toMatchObject({ status: "Completed", output: { worker: "old" } });
            expect(h.calls).toEqual([{ worker: "old", name: "activationUntaggedControl", tag: null }]);
            expect(await h.store.readWorkflowIntake(input.envelope.exchangeId)).toBeNull();
            const beforeJoin = await h.client.readExecutionHistory("protected-intake", pending.info.currentExecutionId);
            expect(scheduledActivities(beforeJoin, WORKFLOW_INTAKE_ACTIVITIES.claim)).toHaveLength(1);
            expect(beforeJoin.filter(event => event.kind === "ActivityCompleted")).toHaveLength(0);

            const current = h.activityWorker("current", true);
            await current.start();
            const result = await h.client.waitForOrchestration("protected-intake", 45_000);
            expect(result).toMatchObject({ status: "Completed", output: {
                claimed: { ok: true, result: { result: "accepted", inserted: true } },
                settled: { ok: true, result: { items: [{ exchangeId: input.envelope.exchangeId, cancelled: true }] } },
            } });
            expect(h.calls.filter(call => call.name !== "activationUntaggedControl")).toEqual([
                { worker: "current", name: WORKFLOW_INTAKE_ACTIVITIES.claim, tag: WORKFLOW_REQUEST_CAPABILITY },
                { worker: "current", name: WORKFLOW_INTAKE_ACTIVITIES.settle, tag: WORKFLOW_REQUEST_CAPABILITY },
            ]);
            expect(await h.store.readWorkflowIntake(input.envelope.exchangeId)).toMatchObject({
                state: "cancelled", claimId: input.claimId, duplicates: 0, conflicts: 0,
            });
            expect(await h.effects()).toEqual(effects);
            const final = await h.client.getInstanceInfo("protected-intake");
            const history = await h.client.readExecutionHistory("protected-intake", final.currentExecutionId);
            expect(scheduledActivities(history, WORKFLOW_INTAKE_ACTIVITIES.claim)).toHaveLength(1);
            expect(scheduledActivities(history, WORKFLOW_INTAKE_ACTIVITIES.settle)).toHaveLength(1);
            expect(history.filter(event => event.kind === "ActivityCompleted")).toHaveLength(2);
            // Both runtimes knew this probe orchestration. This says nothing about routing unknown orchestration versions.
        } finally { await h.close(); }
    });

    it("replays the actual frozen 1.0.82 command history after native runtime replacement without repeating committed events", { timeout: ACTIVATION_SLICE_TIMEOUT }, async () => {
        const h = await activationFixture(getEnv());
        try {
            const sessionId = randomUUID();
            const instanceId = `session-${sessionId}`;
            await h.catalog.createSession(sessionId, { model: "activation-replay-fixture" });
            const first = h.historical82Worker("first");
            await first.start();
            await h.client.startOrchestrationVersioned(instanceId, DURABLE_SESSION_ORCHESTRATION_NAME, {
                sessionId, config: { model: "activation-replay-fixture" }, sourceOrchestrationVersion: "1.0.82",
                iteration: 0, blobEnabled: false, idleTimeout: -1, inputGracePeriod: -1,
                pendingInputQuestion: { question: "Retained question", iteration: 0, allowFreeform: true },
            }, "1.0.82");
            const parked = await nativeBoundary(h, instanceId, "frozen82 initial persisted park", ({ info, history }) => ({
                instanceVersionIs82: info.orchestrationVersion === "1.0.82",
                hasExternalSubscribed: history.some(event => event.kind === "ExternalSubscribed"),
                hasActivityCompleted: history.some(event => event.kind === "ActivityCompleted"),
            }), sessionId);
            const command1 = "before-native-replacement";
            await h.client.enqueueEvent(instanceId, "messages", JSON.stringify({ type: "cmd", cmd: "get_info", id: command1 }));
            const committed = await nativeBoundary(h, instanceId, "frozen82 first command committed before replacement", ({ history }) => {
                const done = history.filter(event => event.kind === "ActivityCompleted");
                const subscribed = history.filter(event => event.kind === "ExternalSubscribed");
                return {
                    atLeastThreeActivitiesCompleted: done.length >= 3,
                    externalSubscriptionCountAdvanced: subscribed.length > parked.history.filter(event => event.kind === "ExternalSubscribed").length,
                    subscriptionFollowsLastCompletion: subscribed.length > 0 && done.length > 0
                        && Number(subscribed.at(-1).eventId) > Number(done.at(-1).eventId),
                };
            }, sessionId);
            expect(committed.info.orchestrationVersion).toBe("1.0.82");
            expect(committed.info.currentExecutionId).toBe(parked.info.currentExecutionId);
            const originalEvents = await h.catalog.getSessionEvents(sessionId, 0, 1000);
            expect(originalEvents.map(event => [event.eventType, event.data.id])).toEqual([
                ["session.command_received", command1], ["session.command_completed", command1],
            ]);
            expect(h.calls.filter(call => call.name === "getWorkerSessionPolicy")).toEqual([{ worker: "first", name: "getWorkerSessionPolicy" }]);
            expect(scheduledActivities(committed.history, "recordSessionEvent")).toHaveLength(2);

            // Completed native history plus the next persisted subscription, not a callback, is the handover boundary.
            await h.stop(first);
            const replacement = h.historical82Worker("replacement");
            await replacement.start();
            const command2 = "after-native-replacement";
            await h.client.enqueueEvent(instanceId, "messages", JSON.stringify({ type: "cmd", cmd: "get_info", id: command2 }));
            const replayed = await nativeBoundary(h, instanceId, "frozen82 second command replayed after replacement", ({ history }) => {
                const done = history.filter(event => event.kind === "ActivityCompleted");
                const subscribed = history.filter(event => event.kind === "ExternalSubscribed");
                return {
                    atLeastFiveActivitiesCompleted: done.length >= 5,
                    externalSubscriptionCountAdvanced: subscribed.length > committed.history.filter(event => event.kind === "ExternalSubscribed").length,
                    subscriptionFollowsLastCompletion: subscribed.length > 0 && done.length > 0
                        && Number(subscribed.at(-1).eventId) > Number(done.at(-1).eventId),
                };
            }, sessionId);
            expect(replayed.info.orchestrationVersion).toBe("1.0.82");
            expect(replayed.info.currentExecutionId).toBe(committed.info.currentExecutionId);
            expect(replayed.history.slice(0, committed.history.length)).toEqual(committed.history);
            const events = await h.catalog.getSessionEvents(sessionId, 0, 1000);
            expect(events.slice(0, originalEvents.length)).toEqual(originalEvents);
            expect(events.map(event => [event.eventType, event.data.id])).toEqual([
                ["session.command_received", command1], ["session.command_completed", command1],
                ["session.command_received", command2], ["session.command_completed", command2],
            ]);
            expect(h.calls.filter(call => call.name === "getWorkerSessionPolicy")).toHaveLength(1);
            expect(h.calls.filter(call => call.name === "recordSessionEvent").map(call => [call.worker, call.events[0].data.id])).toEqual([
                ["first", command1], ["first", command1], ["replacement", command2], ["replacement", command2],
            ]);
            expect(scheduledActivities(replayed.history, "recordSessionEvent")).toHaveLength(4);
            expect(replayed.status.status).toBe("Running");
            const status = typeof replayed.status.customStatus === "string" ? JSON.parse(replayed.status.customStatus) : replayed.status.customStatus;
            expect(status).toMatchObject({ status: "input_required", pendingQuestion: "Retained question" });
            // Scope: real frozen-handler command replay on PostgreSQL; no model/turn snapshot or 1.0.83 proof.
        } finally { await h.close(); }
    });
});
