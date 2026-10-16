import { describe, it } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";
import { assertEqual } from "../helpers/assertions.js";

class FakeCopilotSession {
    registeredTools = [];
    listeners = new Map();
    catchAllHandlers = [];
    scriptedToolCalls = [];
    toolResults = [];
    assistantContent = "ok";
    aborted = false;

    on(eventType, handler) {
        if (typeof eventType === "function") {
            this.catchAllHandlers.push(eventType);
            return () => {
                this.catchAllHandlers = this.catchAllHandlers.filter((candidate) => candidate !== eventType);
            };
        }
        const handlers = this.listeners.get(eventType) ?? [];
        handlers.push(handler);
        this.listeners.set(eventType, handlers);
        return () => {
            const current = this.listeners.get(eventType) ?? [];
            this.listeners.set(eventType, current.filter((candidate) => candidate !== handler));
        };
    }

    registerTools(tools) {
        this.registeredTools = tools;
    }

    emit(eventType, payload = {}) {
        for (const handler of this.catchAllHandlers) {
            handler({ type: eventType, data: payload.data ?? payload });
        }
        const handlers = this.listeners.get(eventType) ?? [];
        for (const handler of handlers) {
            handler(payload);
        }
    }

    async send() {
        this.aborted = false;
        queueMicrotask(async () => {
            for (const call of this.scriptedToolCalls) {
                if (this.aborted) break;
                const tool = this.registeredTools.find((candidate) => candidate.name === call.name);
                if (!tool) throw new Error(`Missing fake tool: ${call.name}`);
                this.toolResults.push(await tool.handler(call.args ?? {}));
            }
            if (!this.aborted && this.assistantContent != null) {
                this.emit("assistant.message", { data: { content: this.assistantContent } });
            }
            this.emit("session.idle", { data: {} });
        });
    }

    abort() {
        this.aborted = true;
    }
}

describe("cron tool plumbing", () => {
    it("queues cron on completed turns without aborting the turn", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "cron", args: { seconds: 45, reason: "check sub-agents and summarize news" } },
        ];
        fakeSession.assistantContent = "Started monitoring.";

        const managed = new ManagedSession("cron-only", fakeSession, {});
        const result = await managed.runTurn("Monitor every 45 seconds.");

        assertEqual(result.type, "completed", "cron-only turn should still complete normally");
        assertEqual(result.content, "Started monitoring.", "cron-only turn should preserve assistant text");
        assertEqual(result.queuedActions?.length ?? 0, 1, "cron-only turn should queue one cron action");
        assertEqual(result.queuedActions?.[0]?.type, "cron", "queued action should be cron");
        assertEqual(result.queuedActions?.[0]?.action, "set", "cron action should schedule");
    });

    it("keeps wait as the primary blocking result when cron is also called", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "cron", args: { seconds: 45, reason: "check sub-agents and summarize news" } },
            { name: "wait", args: { seconds: 120, reason: "poll sub-agents" } },
        ];

        const managed = new ManagedSession("cron-then-wait", fakeSession, { waitThreshold: 0 });
        const result = await managed.runTurn("Monitor every 45 seconds and poll after spawning.");

        assertEqual(result.type, "wait", "wait should remain the primary blocking result");
        assertEqual(result.seconds, 120, "wait result should keep its duration");
        assertEqual(result.reason, "poll sub-agents", "wait result should keep its reason");
        assertEqual(result.queuedActions?.length ?? 0, 1, "cron should survive as a queued action before orchestration handling");
        assertEqual(result.queuedActions?.[0]?.type, "cron", "queued action should be cron");
        assertEqual(result.queuedActions?.[0]?.action, "set", "queued cron action should schedule");
    });

    it("report_cycle records cycle status only during recurring cycle turns", async () => {
        const outsideCycle = new FakeCopilotSession();
        outsideCycle.scriptedToolCalls = [
            { name: "report_cycle", args: { status: "material", summary: "Should be ignored" } },
        ];
        outsideCycle.assistantContent = "done";

        const nonCycleManaged = new ManagedSession("report-cycle-non-cycle", outsideCycle, {});
        const nonCycleResult = await nonCycleManaged.runTurn("ordinary prompt");

        assertEqual(nonCycleResult.type, "completed", "ordinary turn should still complete");
        assertEqual(nonCycleResult.cycleReport, undefined, "report_cycle outside cycle turns should be ignored");

        const cycle = new FakeCopilotSession();
        cycle.scriptedToolCalls = [
            { name: "report_cycle", args: { status: "material", summary: "New blocker", deltas: ["  changed  ", "", 42] } },
        ];
        cycle.assistantContent = "done";

        const cycleManaged = new ManagedSession("report-cycle", cycle, {});
        const cycleResult = await cycleManaged.runTurn("cron wake", { cycleOrigin: "cron" });

        assertEqual(cycleResult.type, "completed", "cycle turn should complete");
        assertEqual(cycleResult.cycleReport?.status, "material", "cycle report status should be preserved");
        assertEqual(cycleResult.cycleReport?.summary, "New blocker", "cycle report summary should be trimmed/preserved");
        assertEqual(cycleResult.cycleReport?.deltas?.join(","), "changed", "cycle report deltas should be sanitized");
    });

    async function cronWith(args, config) {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [{ name: "cron", args }];
        const managed = new ManagedSession("cron-precheck", fakeSession, config);
        const result = await managed.runTurn("Monitor the queue.");
        return { action: result.queuedActions?.[0], toolResult: fakeSession.toolResults[0] };
    }

    it("cron stores a registered precheck named by the call", async () => {
        const { action, toolResult } = await cronWith(
            { seconds: 60, reason: "poll", precheck: " queue " },
            { cronPrecheckNames: ["queue"] },
        );
        assertEqual(action?.precheck, "queue", "the named precheck rides on the cron action");
        assertEqual(JSON.parse(toolResult).precheck, "queue", "the tool result echoes the precheck");
    });

    it("cron rejects a precheck the worker has not registered", async () => {
        const unknown = await cronWith({ seconds: 60, reason: "poll", precheck: "typo" }, { cronPrecheckNames: ["queue"] });
        assertEqual(unknown.action, undefined, "an unknown precheck schedules nothing");
        assertEqual(unknown.toolResult.includes("Registered prechecks: queue"), true, "the error lists registered names");

        const none = await cronWith({ seconds: 60, reason: "poll", precheck: "queue" }, {});
        assertEqual(none.action, undefined, "a worker without prechecks schedules nothing");
        assertEqual(none.toolResult.includes("no registered cron prechecks"), true, "the error says none are registered");
    });

    it("cron uses the session's default precheck unless the call names one", async () => {
        const defaulted = await cronWith({ seconds: 60, reason: "poll" }, { cronPrecheck: "queue", cronPrecheckNames: ["queue", "other"] });
        assertEqual(defaulted.action?.precheck, "queue", "the session default applies");

        const overridden = await cronWith({ seconds: 60, reason: "poll", precheck: "other" }, { cronPrecheck: "queue", cronPrecheckNames: ["queue", "other"] });
        assertEqual(overridden.action?.precheck, "other", "an explicit precheck overrides the default");

        const plain = await cronWith({ seconds: 60, reason: "poll" }, {});
        assertEqual(Object.hasOwn(plain.action ?? {}, "precheck"), false, "no precheck without one named or defaulted");
    });
});
