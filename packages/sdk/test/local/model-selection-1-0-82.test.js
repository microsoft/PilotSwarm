/**
 * Model switching in the frozen orchestration 1.0.82, kept for the sessions still on it (in-flight 1.0.82 histories replay
 * on 1.0.82 until their next continue-as-new). The same cases on 1.0.83, the latest, are in model-selection.test.js,
 * with the real-model scenarios.
 *
 * Run: npx vitest run test/local/model-selection-1-0-82.test.js
 */
import { describe, it } from "vitest";
import { assertEqual, assertNotNull } from "../helpers/assertions.js";
import { detectFailedModelSwitch } from "../../src/orchestration_1_0_82/turn.ts";
import { handleTurnResult, processPrompt } from "../../src/orchestration_1_0_82/turn.ts";
import { handleCommand } from "../../src/orchestration_1_0_82/lifecycle.ts";

const INVALID_MODEL_ID = "github-copilot:gpt-nonexistent-9000";

function runGenerator(gen) {
    let input;
    while (true) {
        const step = gen.next(input);
        if (step.done) return step.value;
        input = step.value;
    }
}

function createFakeModelSwitchRuntime(timerKind) {
    const now = 1_000_000;
    const kv = new Map();
    const events = [];
    const updates = [];
    const continuations = [];
    const runtime = {
        ctx: {
            traceInfo() {},
            getValue(key) { return kv.get(key); },
            setValue(key, value) { kv.set(key, value); },
            clearValue(key) { kv.delete(key); },
            setCustomStatus(value) { runtime.customStatus = value; },
            utcNow() { return now; },
            continueAsNewVersioned(input, version) {
                continuations.push({ input, version });
                return { input, version };
            },
        },
        input: { sessionId: "session-model-switch-timer", config: { model: "github-copilot:gpt-5.4" } },
        versions: { currentVersion: "1.0.82", latestVersion: "1.0.83" },
        manager: {
            loadKnowledgeIndex() { return null; },
            listChildSessions() { return "[]"; },
            summarizeSession() { return null; },
            recordSessionEvent(sessionId, batch) {
                events.push(...batch.map((event) => ({ sessionId, ...event })));
            },
            updateSessionModel(sessionId, model, reasoningEffort) {
                updates.push({ sessionId, model, reasoningEffort });
            },
        },
        session: {},
        options: {
            dehydrateThreshold: 29,
            idleTimeout: -1,
            inputGracePeriod: 0,
            checkpointInterval: -1,
            isSystem: false,
            nestingLevel: 0,
        },
        state: {
            config: { model: "github-copilot:gpt-5.4" },
            affinityKey: "affinity",
            iteration: 1,
            loopIteration: 1,
            retryCount: 0,
            needsHydration: false,
            preserveAffinityOnHydrate: false,
            blobEnabled: false,
            lastLiveSessionAction: "session-activity",
            pendingToolActions: [],
            carriedSteers: [],
            subAgents: [],
            nextSummarizeAt: 0,
            activeTimer: {
                deadlineMs: now + 60_000,
                originalDurationMs: 60_000,
                reason: timerKind === "wait" ? "timer edge wait" : "timer edge cron",
                type: timerKind,
            },
            pendingInputQuestion: null,
            waitingForAgentIds: null,
            interruptedWaitTimer: null,
            interruptedCronTimer: null,
            pendingChildDigest: null,
            pendingShutdown: null,
            lastResponseVersion: 0,
            lastCommandVersion: 0,
            cancelledMessageIds: new Set(),
            emittedCancelledMessageIds: new Set(),
            legacyPendingMessage: undefined,
            orchestrationResult: null,
        },
    };
    return { runtime, events, updates, continuations };
}

function testForceContinuePromptSchedulesBootstrapContinuation() {
    const { runtime, continuations } = createFakeModelSwitchRuntime("wait");
    runtime.state.activeTimer = null;
    runtime.state.interruptedWaitTimer = null;
    runGenerator(handleTurnResult(runtime, {
        type: "completed",
        content: "Model switch failed. Continuing on the unchanged model.",
        forceContinuePrompt: "Continue on github-copilot:gpt-5.4; the requested model switch failed.",
    }, ""));

    assertEqual(continuations.length, 1, "forceContinuePrompt schedules one continuation");
    assertEqual(
        continuations[0].input.prompt,
        "Continue on github-copilot:gpt-5.4; the requested model switch failed.",
        "forceContinuePrompt is carried as the bootstrap continuation prompt",
    );
    assertEqual(continuations[0].input.bootstrapPrompt, true, "correction continuation is bootstrap-only");
}

function testProcessPromptTurnsFailedSwitchIntoCorrectionContinuation() {
    const { runtime, continuations } = createFakeModelSwitchRuntime("wait");
    runtime.state.activeTimer = null;
    runtime.state.interruptedWaitTimer = null;
    runtime.session = {
        runTurn() {
            return {
                type: "completed",
                content: "Model switch failed. Continuing on the unchanged model.",
                events: [
                    {
                        eventType: "tool.execution_complete",
                        data: {
                            toolName: "set_session_model",
                            result: `[SYSTEM: set_session_model failed: Unknown model: ${INVALID_MODEL_ID}]`,
                        },
                    },
                ],
            };
        },
    };

    runGenerator(processPrompt(runtime, "try invalid model", false, "set_session_model"));

    assertEqual(continuations.length, 1, "failed set_session_model processPrompt schedules one continuation");
    assertEqual(
        continuations[0].input.prompt,
        "Continue on github-copilot:gpt-5.4; the requested model switch failed.",
        "failed switch correction continuation prompt is generated from current model",
    );
    assertEqual(continuations[0].input.bootstrapPrompt, true, "failed switch correction continuation is bootstrap-only");
    assertEqual(
        String(continuations[0].input.runtimeModelNotice || "").includes("Previous model switch failed; current runtime model is github-copilot:gpt-5.4"),
        true,
        `runtime model correction notice carried (got ${continuations[0].input.runtimeModelNotice})`,
    );
}

function testProcessPromptTurnsRejectedSwitchIntoCorrectionContinuation() {
    const { runtime, continuations } = createFakeModelSwitchRuntime("wait");
    runtime.state.activeTimer = null;
    runtime.state.interruptedWaitTimer = null;
    runtime.session = {
        runTurn() {
            return {
                type: "completed",
                content: "Model switch failed. Continuing on the unchanged model.",
                events: [
                    {
                        eventType: "tool.execution_complete",
                        data: {
                            toolName: "set_session_model",
                            result: "[SYSTEM: set_session_model rejected by policy.]",
                        },
                    },
                ],
            };
        },
    };

    runGenerator(processPrompt(runtime, "try rejected model", false, "set_session_model"));

    assertEqual(continuations.length, 1, "rejected set_session_model processPrompt schedules one continuation");
    assertEqual(
        continuations[0].input.prompt,
        "Continue on github-copilot:gpt-5.4; the requested model switch failed.",
        "rejected switch correction continuation prompt is generated from current model",
    );
    assertEqual(continuations[0].input.bootstrapPrompt, true, "rejected switch correction continuation is bootstrap-only");
}

function testSystemSessionSetModelUsesOrdinaryCommandPath() {
    const { runtime, events, updates, continuations } = createFakeModelSwitchRuntime("wait");
    runtime.options.isSystem = true;
    runtime.input.isSystem = true;
    runtime.state.activeTimer = null;

    runGenerator(handleCommand(runtime, {
        type: "cmd",
        cmd: "set_model",
        id: "cmd-system-set-model",
        args: { model: "github-copilot:gpt-5.5", reasoningEffort: "xhigh", source: "user" },
    }));

    assertEqual(updates.length, 1, "system set_model records one model update");
    assertEqual(updates[0].model, "github-copilot:gpt-5.5", "system set_model targets selected model");
    assertEqual(updates[0].reasoningEffort, "xhigh", "system set_model carries selected effort");
    const modelChanged = events.find((event) => event.eventType === "session.model_changed");
    assertNotNull(modelChanged, "system set_model records model_changed event");
    assertEqual(modelChanged.data?.source, "user", "system set_model keeps control-plane source");
    assertEqual(continuations.length, 1, "system set_model schedules one continue-as-new");
    assertEqual(continuations[0].input.prompt, "Continue on github-copilot:gpt-5.5:xhigh.", "system set_model continuation prompt targets new model");
    assertEqual(continuations[0].input.isSystem, true, "system set_model preserves system-session input flag");
}

function testInterruptedWaitAutoResumesAfterModelSwitchContinuation() {
    const { runtime } = createFakeModelSwitchRuntime("wait");
    runtime.state.activeTimer = null;
    runtime.state.interruptedWaitTimer = {
        remainingSec: 42,
        reason: "resume after model switch",
        shouldRehydrate: false,
    };

    runGenerator(handleTurnResult(runtime, {
        type: "completed",
        content: "Continue on the selected model.",
    }, "Continue on github-copilot:gpt-5.5."));

    assertEqual(runtime.state.interruptedWaitTimer, null, "interrupted wait marker is consumed");
    assertNotNull(runtime.state.activeTimer, "interrupted wait is restored after continuation");
    assertEqual(runtime.state.activeTimer.type, "wait", "restored timer remains a wait");
    assertEqual(runtime.state.activeTimer.reason, "resume after model switch", "restored wait keeps reason");
    assertEqual(runtime.state.activeTimer.deadlineMs, 1_042_000, "restored wait keeps remaining duration");
}

function testModelSwitchInterruptsTimerCommand(timerKind) {
    const { runtime, events, updates, continuations } = createFakeModelSwitchRuntime(timerKind);
    runGenerator(handleCommand(runtime, {
        type: "cmd",
        cmd: "set_model",
        id: `cmd-${timerKind}`,
        args: { model: "github-copilot:gpt-5.5", source: "user" },
    }));

    assertEqual(runtime.state.activeTimer, null, `${timerKind} active timer is cleared before continuation`);
    if (timerKind === "wait") {
        assertNotNull(runtime.state.interruptedWaitTimer, "wait timer captured for auto-resume");
        assertEqual(runtime.state.interruptedWaitTimer.remainingSec, 60, "wait remaining time preserved");
    } else {
        assertNotNull(runtime.state.interruptedCronTimer, "cron timer captured for auto-resume");
        assertEqual(runtime.state.interruptedCronTimer.remainingMs, 60_000, "cron remaining time preserved");
    }
    assertEqual(updates.length, 1, "model update is recorded");
    assertEqual(updates[0].model, "github-copilot:gpt-5.5", "model update targets selected model");
    assertEqual(events.some((event) => event.eventType === "session.model_changed"), true, "model_changed event recorded");
    assertEqual(continuations.length, 1, "set_model schedules one continue-as-new");
    assertEqual(continuations[0].input.prompt, "Continue on github-copilot:gpt-5.5.", "continuation prompt targets new model");
    assertEqual(continuations[0].input.activeTimerState, undefined, "active timer is not carried ahead to block continuation");
}

/**
 * Deterministic check for the failed-switch detection that backs the one-shot
 * correction notice. The `set_session_model` inline control tool reports its
 * outcome as a plain string, so detection must handle a string `result` (the
 * real SDK shape) as well as an object `{ content }`.
 */
function testDetectFailedModelSwitch() {
    const failStringShape = [
        { eventType: "tool.execution_start", data: { toolName: "set_session_model" } },
        { eventType: "tool.execution_complete", data: { toolName: "set_session_model", result: "[SYSTEM: set_session_model failed: Unknown model: github-copilot:gpt-nonexistent-9000]" } },
    ];
    assertEqual(Boolean(detectFailedModelSwitch(failStringShape)), true, "detects failure when result is a plain string (real SDK shape)");

    const failObjectShape = [
        { eventType: "tool.execution_complete", data: { toolName: "set_session_model", result: { content: "[SYSTEM: set_session_model failed: no storeUrl is configured.]" } } },
    ];
    assertEqual(Boolean(detectFailedModelSwitch(failObjectShape)), true, "detects failure when result is an object with content");

    const successShape = [
        { eventType: "tool.execution_complete", data: { toolName: "set_session_model", result: "[SYSTEM: Model switch accepted. The next turn will use github-copilot:gpt-5.5.]" } },
    ];
    assertEqual(detectFailedModelSwitch(successShape), null, "a successful switch is not treated as a failure");

    const unrelatedFailure = [
        { eventType: "tool.execution_complete", data: { toolName: "spawn_agent", result: "[SYSTEM: spawn_agent failed: boom]" } },
    ];
    assertEqual(detectFailedModelSwitch(unrelatedFailure), null, "unrelated tool failures are ignored");

    assertEqual(detectFailedModelSwitch([]), null, "empty events -> null");
    assertEqual(detectFailedModelSwitch(undefined), null, "undefined events -> null");
}

describe("Model switching on the frozen orchestration 1.0.82", () => {
    it("detectFailedModelSwitch flags failed set_session_model tool results", () => {
        testDetectFailedModelSwitch();
    });
    it("failed model switch force-continuation is bootstrap", () => {
        testForceContinuePromptSchedulesBootstrapContinuation();
    });
    it("processPrompt turns failed set_session_model into correction continuation", () => {
        testProcessPromptTurnsFailedSwitchIntoCorrectionContinuation();
    });
    it("processPrompt turns rejected set_session_model into correction continuation", () => {
        testProcessPromptTurnsRejectedSwitchIntoCorrectionContinuation();
    });
    it("system sessions use ordinary set_model command handling", () => {
        testSystemSessionSetModelUsesOrdinaryCommandPath();
    });
    it("set_model interrupts active wait timer before auto-continuation", () => {
        testModelSwitchInterruptsTimerCommand("wait");
    });
    it("set_model interrupts active cron timer before auto-continuation", () => {
        testModelSwitchInterruptsTimerCommand("cron");
    });
    it("interrupted wait auto-resumes after model-switch continuation", () => {
        testInterruptedWaitAutoResumesAfterModelSwitchContinuation();
    });
});
