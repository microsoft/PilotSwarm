/**
 * Warm-resume cases that drive the frozen orchestration 1.0.82's own modules (drain and the auth-failure projection),
 * kept for the sessions still on it (in-flight 1.0.82 histories replay on 1.0.82 until their next continue-as-new). The
 * same cases on 1.0.83, the latest, with the version-independent upgrade cases, are in
 * orchestration-warm-resume.test.js.
 */
import { describe, expect, it } from "vitest";

describe("orchestration warm resume durability on the frozen 1.0.82", () => {
    it("dispatches an answer immediately when it interrupts the input-required idle hold", async () => {
        const values = new Map();
        const { drain } = await import("../../src/orchestration_1_0_82/queue.ts");
        const activeTimer = {
            deadlineMs: 1_800_000,
            originalDurationMs: 1_800_000,
            reason: "idle timeout (input required)",
            type: "idle",
        };
        const runtime = {
            ctx: {
                traceInfo: () => {},
                getValue: (key) => values.get(key) ?? null,
                setValue: (key, value) => values.set(key, value),
                clearValue: (key) => values.delete(key),
                utcNow: () => ({ effect: "utcNow" }),
                dequeueEvent: () => ({ effect: "dequeueEvent" }),
                scheduleTimer: (ms) => ({ effect: "scheduleTimer", ms }),
                race: (left, right) => ({ effect: "race", left, right }),
            },
            state: {
                legacyPendingMessage: undefined,
                activeTimer,
                pendingChildDigest: null,
                pendingToolActions: [],
                pendingPrompt: undefined,
                carriedSteers: [],
                pendingInputQuestion: {
                    question: "Authorize feature registration?",
                    iteration: 3,
                    allowFreeform: true,
                },
                cancelledMessageIds: new Set(),
                orchestrationResult: null,
            },
        };

        const gen = drain(runtime);
        expect(gen.next().value).toEqual({ effect: "utcNow" });
        const raceEffect = gen.next(1_000).value;
        expect(raceEffect).toMatchObject({ effect: "race" });

        const afterAnswer = gen.next({
            index: 0,
            value: JSON.stringify({ answer: "Authorize", wasFreeform: true }),
        });

        expect(afterAnswer.done).toBe(true);
        expect(runtime.state.activeTimer).toBeNull();
        expect(JSON.parse(values.get("fifo.0"))).toEqual([
            { kind: "answer", answer: "Authorize", wasFreeform: true, expectedQuestion: { question: "Authorize feature registration?", iteration: 3 } },
        ]);
    });

    it("projects auth failures durably and keeps them visible until the next prompt", async () => {
        const values = new Map();
        const statuses = [];
        const { projectAuthFailure } = await import("../../src/orchestration_1_0_82/turn.ts");
        const { drain } = await import("../../src/orchestration_1_0_82/queue.ts");
        const { RESPONSE_LATEST_KEY } = await import("../../src/types.ts");
        const runtime = {
            input: { sessionId: "auth-blocked", config: {} },
            ctx: {
                traceInfo: () => {},
                getValue: (key) => values.get(key) ?? null,
                setValue: (key, value) => values.set(key, value),
                clearValue: (key) => values.delete(key),
                setCustomStatus: (status) => statuses.push(JSON.parse(status)),
                utcNow: () => ({ effect: "utcNow" }),
                dequeueEvent: () => ({ effect: "dequeueEvent" }),
                scheduleTimer: (ms) => ({ effect: "scheduleTimer", ms }),
                race: (left, right) => ({ effect: "race", left, right }),
            },
            manager: {
                updateCmsState: (...args) => ({ effect: "updateCmsState", args }),
            },
            state: {
                iteration: 0,
                retryCount: 2,
                lastResponseVersion: 0,
                lastCommandVersion: 0,
                cronSchedule: undefined,
                cronAtSchedule: undefined,
                contextUsage: undefined,
                legacyPendingMessage: undefined,
                activeTimer: null,
                pendingChildDigest: null,
                pendingToolActions: [],
                pendingPrompt: undefined,
                pendingInputQuestion: null,
                waitingForAgentIds: null,
                pendingShutdown: null,
                cancelledMessageIds: new Set(),
                emittedCancelledMessageIds: new Set(),
                orchestrationResult: null,
            },
        };

        const projection = projectAuthFailure(
            runtime,
            "Authentication failed: Failed to validate SDK token (401): GitHub returned: Bad credentials",
        );
        expect(projection.next().value).toEqual({ effect: "utcNow" });
        const cmsUpdate = projection.next(1_000).value;
        expect(cmsUpdate).toMatchObject({ effect: "updateCmsState" });
        expect(cmsUpdate.args[1]).toBe("error");
        expect(cmsUpdate.args[2]).toContain("Bad credentials");
        expect(projection.next().done).toBe(true);

        const latestResponse = JSON.parse(values.get(RESPONSE_LATEST_KEY));
        expect(latestResponse).toMatchObject({ type: "error", iteration: 0, version: 1 });
        expect(latestResponse.content).toContain("Admin");
        expect(runtime.state.blockedError.authFailure).toBe(true);
        expect(runtime.state.retryCount).toBe(0);

        const blockedDrain = drain(runtime);
        expect(blockedDrain.next().value).toEqual({ effect: "dequeueEvent" });
        expect(statuses.at(-1)).toMatchObject({ status: "error", authFailure: true });

        const afterPrompt = blockedDrain.next({ prompt: "retry after fixing my key" });
        // 1.0.82 (issue 192, R10): after collecting a message, drain sweeps
        // for 10 ms for more before it stops.
        expect(afterPrompt.value).toMatchObject({ effect: "race", right: { effect: "scheduleTimer", ms: 10 } });
        const afterSweep = blockedDrain.next({ index: 1 });
        expect(afterSweep.done).toBe(true);
        expect(runtime.state.blockedError).toBeUndefined();
        expect(JSON.parse(values.get("fifo.0"))).toEqual([
            { kind: "prompt", prompt: "retry after fixing my key", bootstrap: false },
        ]);
    });

});
