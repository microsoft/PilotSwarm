import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CARRIED_STEERS_WAKE_PROMPT } from "../../src/turn-control-contract.ts";
import { SESSION_STATE_MISSING_PREFIX } from "../../src/types.ts";
import { createRuntime } from "../../src/orchestration/runtime.ts";
import { processPrompt } from "../../src/orchestration/turn.ts";
import { processPrompt as legacyProcessPrompt } from "../../src/orchestration_1_0_80/turn.ts";
import { appendToFifo, decide, drain } from "../../src/orchestration/queue.ts";
import { buildContinueInput } from "../../src/orchestration/lifecycle.ts";
import { completeSession, cancelSession, failPendingShutdown } from "../../src/orchestration/agents.ts";

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: (ctx, sessionId, affinity, config, contract) => ctx.proxy("session", contract),
    createSessionManagerProxy: (ctx, contract) => ctx.proxy("manager", contract),
}));

const steer = (seq, text = `guidance ${seq}`) => ({ seq, text });

function harness(overrides = {}) {
    const calls = [];
    const routes = [];
    const turns = [];
    const results = [];
    const messages = [];
    const kv = new Map();
    let now = 1_750_000_000_000;
    let guid = 0;
    const ctx = {
        traceInfo() {},
        setCustomStatus() {},
        getValue: key => kv.get(key) ?? null,
        setValue: (key, value) => kv.set(key, value),
        clearValue: key => kv.delete(key),
        utcNow: () => ({ effect: "now" }),
        newGuid: () => ({ effect: "guid" }),
        scheduleTimer: ms => ({ effect: "timer", ms }),
        dequeueEvent: name => ({ effect: "dequeue", name }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "can", input, version }),
        proxy(prefix, contract) {
            routes.push({ prefix, contract });
            return new Proxy({}, {
                get: (_, name) => (...args) => ({ effect: `${prefix}.${String(name)}`, args }),
            });
        },
    };
    function resolve(effect) {
        if (effect == null) return undefined;
        calls.push(effect);
        switch (effect.effect) {
            case "now": return now;
            case "guid": return `recorded-guid-${++guid}`;
            case "timer": now += effect.ms; return undefined;
            case "dequeue":
                if (!messages.length) throw new Error("unexpected blocking dequeue");
                return JSON.stringify(messages.shift());
            case "race":
                if (effect.left?.effect === "session.runTurn") {
                    return { index: 0, value: resolve(effect.left) };
                }
                if (effect.left?.effect === "dequeue") {
                    if (messages.length) return { index: 0, value: JSON.stringify(messages.shift()) };
                    now += effect.right.ms;
                    return { index: 1 };
                }
                if (effect.left?.effect === "session.releaseWorkspace") return { index: 0, value: { released: true } };
                throw new Error(`unexpected race: ${JSON.stringify(effect)}`);
            case "session.runTurn": {
                turns.push(effect.args);
                if (!results.length) throw new Error("unexpected turn");
                const result = results.shift();
                if (result instanceof Error) throw result;
                return result;
            }
            case "session.hydrate":
                if (overrides.hydrateError) throw new Error(overrides.hydrateError);
                return undefined;
            case "manager.updateCmsState": return overrides.updateCmsStateResult;
            case "manager.listChildSessions": return "[]";
            case "manager.getWorkerSessionPolicy": return { policy: null, allowedAgentNames: [] };
            case "manager.resolveAgentConfig": return null;
            case "manager.getOrchestrationStats": return { historySizeBytes: 0 };
            default: return undefined;
        }
    }
    function drive(gen) {
        let value;
        let failure;
        for (let step = 0; step < 800; step++) {
            const next = failure ? gen.throw(failure) : gen.next(value);
            failure = undefined;
            if (next.done) return next.value;
            try { value = resolve(next.value); } catch (error) { failure = error; }
        }
        throw new Error("generator exceeded bound");
    }
    const { updateCmsStateResult: _updateCmsStateResult, ...inputOverrides } = overrides;
    const runtime = drive(createRuntime(ctx, {
        sessionId: "turn-control-fixture",
        config: {},
        iteration: 4,
        isSystem: true,
        blobEnabled: false,
        ...inputOverrides,
    }, { currentVersion: "1.0.81", latestVersion: "1.0.81" }));
    const run = (result, prompt = "original prompt", ids) => {
        results.push(result);
        drive(processPrompt(runtime, prompt, false, undefined, ids));
    };
    return { runtime, calls, routes, turns, results, messages, drive, run };
}

describe("1.0.81 turn control orchestration", () => {
    it("routes every rebuilt session proxy through the V4 contract", () => {
        const h = harness();
        h.run({ type: "completed", content: "done" });
        expect(h.routes.every(route => route.contract === "turn-control-v1")).toBe(true);
        expect(h.calls.some(call => call.effect === "race" && call.left?.effect === "session.runTurn")).toBe(false);
        expect(h.calls.some(call => call.effect === "dequeue" && call.name.startsWith("stopTurn."))).toBe(false);
        expect(h.calls.some(call => call.effect === "session.abortTurn")).toBe(false);
    });
    it("late steers start a turn at once, once, and are not recorded as new user messages", () => {
        const h = harness();
        h.run({ type: "completed", content: "first", lateSteers: [steer(10), steer(11)] });
        h.drive(drain(h.runtime));
        h.results.push({ type: "completed", content: "carried", carriedSteersConsumed: true });
        h.drive(decide(h.runtime));
        expect(h.turns).toHaveLength(2);
        expect(h.turns[1][0]).toBe(CARRIED_STEERS_WAKE_PROMPT);
        expect(h.turns[1][2]).toBe(5);
        expect(h.turns[1][3].carriedSteers).toEqual([steer(10), steer(11)]);
        expect(h.runtime.state.carriedSteers).toEqual([]);
        expect(h.calls.flatMap(c => c.effect === "manager.recordSessionEvent" ? c.args[1] : []).filter(e => e.eventType === "user.message")).toEqual([]);
    });

    it("pending ordinary work receives carried steers instead of an extra turn", () => {
        const h = harness();
        h.run({ type: "completed", content: "first", lateSteers: [steer(12)] });
        h.messages.push({ prompt: "new user prompt", clientMessageIds: ["message-2"] });
        h.drive(drain(h.runtime));
        h.results.push({ type: "completed", content: "next", carriedSteersConsumed: true });
        h.drive(decide(h.runtime));
        expect(h.turns[1][0]).toBe("new user prompt");
        expect(h.turns[1][3].carriedSteers).toEqual([steer(12)]);
    });

    it("a carried-only wake keeps its marker in an attributed shared session", () => {
        const h = harness({ multiWriter: true, sharedPreambleSent: true });
        h.run({ type: "completed", content: "first", lateSteers: [steer(14)] });
        h.drive(drain(h.runtime));
        h.results.push({ type: "completed", content: "carried", carriedSteersConsumed: true });
        h.drive(decide(h.runtime));
        expect(h.turns[1][0]).toBe(CARRIED_STEERS_WAKE_PROMPT);
        expect(h.turns[1][1]).toBe(true);
    });

    it("a carried-only retry preserves its system-context note exactly once", () => {
        const h = harness({ carriedSteers: [steer(15)], systemPrompt: "original wake note" });
        h.run({ type: "error", message: "transient", carriedSteersConsumed: true }, CARRIED_STEERS_WAKE_PROMPT);
        const next = h.calls.find(c => c.effect === "can").input;
        const retry = harness(next);
        retry.run({ type: "completed", content: "retry", carriedSteersConsumed: true }, next.prompt);
        expect(retry.turns[0][0]).toBe(h.turns[0][0]);
        expect(retry.turns[0][0].match(/original wake note/g)).toHaveLength(1);
    });

    it("a question holds the carry until the user's answer", () => {
        const h = harness();
        h.run({ type: "input_required", question: "which path?", lateSteers: [steer(13)] });
        expect(buildContinueInput(h.runtime).carriedSteers).toEqual([steer(13)]);
        appendToFifo(h.runtime, [{ kind: "answer", answer: "v2", question: "which path?" }]);
        h.results.push({ type: "completed", content: "answered", carriedSteersConsumed: true });
        h.drive(decide(h.runtime));
        expect(h.turns[1][0]).toContain("v2");
        expect(h.turns[1][3].carriedSteers).toEqual([steer(13)]);
        expect(h.runtime.state.carriedSteers).toEqual([]);
    });

    for (const [label, result] of [
        ["budget wait", { type: "wait", seconds: 30, reason: "budget", budget: true }],
        ["workspace wait", { type: "wait", seconds: 30, reason: "workspace", gate: "workspace", code: "WORKSPACE_FOLDER_MISSING", workerNodeId: "fixture" }],
        ["provider admission error without workspace", { type: "error", message: "provider admission failed" }],
        ["returned model error", { type: "error", message: "model failed", carriedSteersConsumed: true }],
        ["stale start", { type: "cancelled", reason: "stale_start" }],
    ]) {
        it(`keeps carried steers on ${label}`, () => {
            const h = harness({ carriedSteers: [steer(20)] });
            h.run(result);
            expect(h.runtime.state.carriedSteers).toEqual([steer(20)]);
            const carried = h.calls.find(call => call.effect === "can")?.input ?? buildContinueInput(h.runtime);
            expect(carried.carriedSteers).toEqual([steer(20)]);
        });
    }

    it("a thrown turn error retains carry and prompt for retry", () => {
        const h = harness({ carriedSteers: [steer(21)] });
        h.run(new Error("transient turn failure"));
        const next = h.calls.find(c => c.effect === "can");
        expect(next.input.carriedSteers).toEqual([steer(21)]);
        expect(next.input.prompt).toBe("original prompt");
        expect(next.input.retryCount).toBe(1);
    });

    it("hydrate exhaustion adds only a give-up CMS write to the legacy activity sequence", () => {
        const input = { carriedSteers: [steer(27)], blobEnabled: true, needsHydration: true, hydrateError: "storage failed" };
        const current = harness(input);
        current.run({ type: "completed", content: "must not run" });
        const writes = current.calls.filter(c => c.effect === "manager.updateCmsState");
        expect(writes).toHaveLength(1);
        expect(writes[0].args).toEqual(["turn-control-fixture", "error", "Hydrate failed after 3 attempts: storage failed", null, { closeControls: true }]);
        expect(current.runtime.state.carriedSteers).toEqual([]);
        expect(current.turns).toEqual([]);
        const legacy = harness(input);
        legacy.drive(legacyProcessPrompt(legacy.runtime, "original prompt", false));
        expect(current.calls.filter(c => c.effect !== "manager.updateCmsState").map(c => c.effect))
            .toEqual(legacy.calls.map(c => c.effect));
    });

    it("hydrate exhaustion is a give-up: it drops a thrown turn's key and resets the retry count, with no extra yield", () => {
        const input = { blobEnabled: true, needsHydration: true, hydrateError: "storage failed", retryCount: 2, thrownTurnKey: "recorded-guid-old" };
        const current = harness(input);
        current.run({ type: "completed", content: "must not run" });
        expect(current.turns).toEqual([]);
        expect(current.runtime.state.thrownTurnKey).toBeNull();
        expect(current.runtime.state.retryCount).toBe(0);
        const legacy = harness(input);
        legacy.drive(legacyProcessPrompt(legacy.runtime, "original prompt", false));
        expect(current.calls.filter(c => c.effect !== "manager.updateCmsState").map(c => c.effect))
            .toEqual(legacy.calls.map(c => c.effect));
    });

    it("storeless connection-loss give-up adds only one CMS write to the legacy activity sequence", () => {
        const input = { carriedSteers: [steer(28)], retryCount: 3 };
        const current = harness(input);
        current.run(new Error("Connection is closed"));
        const writes = current.calls.filter(c => c.effect === "manager.updateCmsState");
        expect(writes).toHaveLength(1);
        expect(writes[0].args[2]).toContain("Durable handoff is unavailable because blob persistence is disabled.");
        expect(writes[0].args[4]).toEqual({ closeControls: true });
        expect(current.runtime.state.carriedSteers).toEqual([]);
        const legacy = harness(input);
        legacy.results.push(new Error("Connection is closed"));
        legacy.drive(legacyProcessPrompt(legacy.runtime, "original prompt", false));
        expect(current.calls.filter(c => c.effect !== "manager.updateCmsState").map(c => c.effect))
            .toEqual(legacy.calls.filter(c => c.effect !== "race").map(c => c.effect));
    });

    it("a retryable returned error retains old and new late steers even after consumption", () => {
        const h = harness({ carriedSteers: [steer(22)] });
        h.run({ type: "error", message: "transient", carriedSteersConsumed: true, lateSteers: [steer(23)] }, CARRIED_STEERS_WAKE_PROMPT);
        const next = h.calls.find(c => c.effect === "can");
        expect(next.input.prompt).toBe(CARRIED_STEERS_WAKE_PROMPT);
        expect(next.input.carriedSteers).toEqual([steer(22), steer(23)]);
        const retry = harness(next.input);
        retry.run({ type: "completed", content: "retry", carriedSteersConsumed: true }, next.input.prompt);
        expect(retry.turns[0][3].carriedSteers).toEqual([steer(22), steer(23)]);
        expect(retry.runtime.state.carriedSteers).toEqual([]);
    });

    it("clears consumed old steers before appending new late steers", () => {
        const h = harness({ carriedSteers: [steer(24)] });
        h.run({ type: "completed", content: "done", carriedSteersConsumed: true, lateSteers: [steer(25)] });
        expect(h.runtime.state.carriedSteers).toEqual([steer(25)]);
    });

    it("a stopped consuming turn clears carry without retry or a duplicate transcript line", () => {
        const h = harness({ carriedSteers: [steer(26)], retryCount: 2 });
        h.run({ type: "stopped", carriedSteersConsumed: true }, "consume", ["original-id"]);
        expect(h.runtime.state.carriedSteers).toEqual([]);
        expect(h.runtime.state.retryCount).toBe(0);
        expect(h.calls.filter(c => c.effect === "can")).toEqual([]);
        const events = h.calls.flatMap(c => c.effect === "manager.recordSessionEvent" ? c.args[1] : []);
        expect(events.find(e => e.eventType === "session.turn_stopped").data).toMatchObject({ turnIndex: 4, clientMessageIds: ["original-id"] });
        expect(events.filter(e => e.eventType === "system.message")).toEqual([]);
        expect(h.calls.find(c => c.effect === "manager.updateCmsState").args).toEqual(["turn-control-fixture", "idle"]);
    });

    it("Stop preserves an interrupted wait", () => {
        const h = harness({ interruptedWaitTimer: { remainingSec: 42, reason: "original wait" } });
        h.run({ type: "stopped" });
        expect(h.runtime.state.activeTimer).toMatchObject({ type: "wait", originalDurationMs: 42_000, reason: "original wait" });
    });

    it("Stop preserves cron", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 300, reason: "original cron" } });
        h.run({ type: "stopped" });
        expect(h.runtime.state.cronSchedule).toMatchObject({ intervalSeconds: 300, reason: "original cron" });
        expect(h.runtime.state.activeTimer).toMatchObject({ type: "cron" });
    });

    for (const [label, result, input] of [
        ["retry exhaustion", { type: "error", message: "transient" }, { retryCount: 2 }],
        ["non-retryable", { type: "error", message: "not retryable", retryable: false }, {}],
        ["auth", { type: "error", message: "401 unauthorized" }, {}],
        ["storeless connection-loss exhaustion", new Error("Connection is closed"), { retryCount: 3 }],
    ]) {
        it(`${label} closes controls in the give-up state write`, () => {
            const h = harness({ ...input, carriedSteers: [steer(30)] });
            h.run(result);
            expect(h.runtime.state.carriedSteers).toEqual([]);
            expect(h.calls.filter(c => c.effect === "manager.updateCmsState").at(-1).args[4]).toEqual({ closeControls: true });
            expect(h.calls.filter(c => c.effect === "can")).toEqual([]);
        });
    }

    for (const thrown of [false, true]) {
        it(`fatal missing state (${thrown ? "thrown" : "returned"}) closes terminal controls in SQL`, () => {
            const h = harness({ carriedSteers: [steer(31)] });
            const message = `${SESSION_STATE_MISSING_PREFIX}lost saved state`;
            expect(() => h.run(thrown ? new Error(message) : { type: "error", message })).toThrow("lost saved state");
            expect(h.runtime.state.carriedSteers).toEqual([]);
            const write = h.calls.filter(c => c.effect === "manager.updateCmsState").at(-1);
            expect(write.args[1]).toBe("failed");
            expect(write.args[4]).toBeUndefined();
        });
    }

    for (const [label, action] of [
        ["completed", runtime => completeSession(runtime, "finished")],
        ["cancelled", runtime => cancelSession(runtime, "cancelled")],
        ["failed", runtime => failPendingShutdown(runtime, "shutdown failed")],
    ]) {
        it(`${label} terminal write clears carry and leaves closing to SQL`, () => {
            const h = harness({ carriedSteers: [steer(32)] });
            h.drive(action(h.runtime));
            expect(h.runtime.state.carriedSteers).toEqual([]);
            const write = h.calls.filter(c => c.effect === "manager.updateCmsState").at(-1);
            expect(write.args[1]).toBe(label);
            expect(write.args[4]).toBeUndefined();
        });
    }

    it("carries ordered steers across every continue-as-new input", () => {
        const h = harness({ carriedSteers: [steer(40), steer(41)] });
        const next = buildContinueInput(h.runtime, { prompt: "retry" });
        expect(next.carriedSteers).toEqual([steer(40), steer(41)]);
        const resumed = harness(next);
        expect(resumed.runtime.state.carriedSteers).toEqual(next.carriedSteers);
        expect(resumed.runtime.state.carriedSteers).not.toBe(next.carriedSteers);
    });

    it("never schedules a carried-steer-closing activity or reads nondeterministic time", () => {
        const h = harness({ carriedSteers: [steer(42)] });
        h.run({ type: "completed", content: "done", carriedSteersConsumed: true });
        expect(h.calls.filter(c => /closeCarriedSteers/i.test(c.effect))).toEqual([]);
        const source = ["turn", "state", "runtime", "lifecycle"].map(file =>
            readFileSync(new URL(`../../src/orchestration/${file}.ts`, import.meta.url), "utf8")).join("\n");
        expect(source).not.toMatch(/Date\.now\(|Math\.random\(|crypto\.randomUUID\(|setTimeout\(|setInterval\(/);
        expect(source).not.toMatch(/stopTurnQueueName|abortTurn\(/);
    });

    it("an uncontrolled turn schedules the same activities as frozen 1.0.80 without its Stop race", () => {
        const current = harness();
        current.run({ type: "completed", content: "done" });
        const legacy = harness();
        legacy.results.push({ type: "completed", content: "done" });
        legacy.drive(legacyProcessPrompt(legacy.runtime, "original prompt", false));
        const scheduled = calls => calls.filter(c => c.effect !== "race").map(c => ({ effect: c.effect, args: c.args }));
        expect(scheduled(current.calls)).toEqual(scheduled(legacy.calls));
    });

    it("a 1.0.80 input continued into 1.0.81 runs its next turn through the V4 contract", () => {
        const h = harness({ sourceOrchestrationVersion: "1.0.80", iteration: 7 });
        h.run({ type: "completed", content: "done" });
        expect(h.routes.length).toBeGreaterThan(0);
        expect(h.routes.every(route => route.contract === "turn-control-v1")).toBe(true);
        expect(h.turns[0][2]).toBe(7);
    });

    describe("carried wake scheduling", () => {
        const START = 1_750_000_000_000;
        const drainCalls = h => {
            const before = h.calls.length;
            h.drive(drain(h.runtime));
            return h.calls.slice(before);
        };

        it("a pending question holds the carry: drain blocks for the answer", () => {
            const h = harness({ carriedSteers: [steer(50)] });
            h.runtime.state.pendingInputQuestion = { question: "which path?", iteration: 4 };
            const before = h.calls.length;
            expect(() => h.drive(drain(h.runtime))).toThrow("unexpected blocking dequeue");
            const drained = h.calls.slice(before);
            expect(drained.some(c => c.effect === "race")).toBe(false);
            expect(drained.at(-1)).toMatchObject({ effect: "dequeue", name: "messages" });
            expect(h.runtime.state.carriedSteers).toEqual([steer(50)]);
        });

        it("a gate wait holds the carry: drain races the gate timer, not a wake", () => {
            const h = harness({ carriedSteers: [steer(51)] });
            h.runtime.state.activeTimer = {
                type: "wait", deadlineMs: START + 3_600_000, originalDurationMs: 3_600_000, reason: "budget", budget: true,
            };
            const races = drainCalls(h).filter(c => c.effect === "race");
            expect(races[0].right).toMatchObject({ effect: "timer" });
            expect(races[0].right.ms).toBeGreaterThan(1_000);
            expect(h.turns).toEqual([]);
            expect(h.runtime.state.carriedSteers).toEqual([steer(51)]);
        });

        it("a pending shutdown holds the carry: drain races the shutdown poll, not a wake", () => {
            const h = harness({ carriedSteers: [steer(54)] });
            h.runtime.state.pendingShutdown = {
                mode: "done", reason: "finished", startedAtMs: START, deadlineAtMs: START + 60_000,
                targetAgentIds: ["agent-1"], commandId: "cmd-1",
            };
            h.runtime.state.waitingForAgentIds = ["agent-1"];
            h.runtime.state.activeTimer = {
                type: "agent-poll", deadlineMs: START + 3_600_000, originalDurationMs: 3_600_000,
                reason: "shutting down", agentIds: ["agent-1"],
            };
            const races = drainCalls(h).filter(c => c.effect === "race");
            expect(races[0].right.ms).toBeGreaterThan(1_000);
            expect(h.turns).toEqual([]);
            expect(h.runtime.state.carriedSteers).toEqual([steer(54)]);
        });

        it("a carried wake interrupts a wait like a message and resumes it after the turn", () => {
            const h = harness({ carriedSteers: [steer(52)] });
            h.runtime.state.activeTimer = {
                type: "wait", deadlineMs: START + 3_600_000, originalDurationMs: 3_600_000, reason: "poll later",
            };
            h.drive(drain(h.runtime));
            expect(h.runtime.state.interruptedWaitTimer).toMatchObject({ reason: "poll later", interruptKind: "user" });
            h.results.push({ type: "completed", content: "steered", carriedSteersConsumed: true });
            h.drive(decide(h.runtime));
            const [prompt, bootstrap, , meta] = h.turns.at(-1);
            expect(prompt.startsWith(CARRIED_STEERS_WAKE_PROMPT)).toBe(true);
            expect(prompt).toContain("interrupted your 3600s timer");
            expect(bootstrap).toBe(true);
            expect(meta.carriedSteers).toEqual([steer(52)]);
            expect(h.runtime.state.carriedSteers).toEqual([]);
            expect(h.runtime.state.activeTimer).toMatchObject({ type: "wait", reason: "poll later" });
        });

        it("a carried wake interrupts cron like a message and keeps the schedule", () => {
            const h = harness({ carriedSteers: [steer(53)], cronSchedule: { intervalSeconds: 300, reason: "original cron" } });
            h.runtime.state.activeTimer = {
                type: "cron", deadlineMs: START + 300_000, originalDurationMs: 300_000, reason: "original cron",
            };
            h.drive(drain(h.runtime));
            expect(h.runtime.state.interruptedCronTimer).toMatchObject({ reason: "original cron" });
            h.results.push({ type: "completed", content: "steered", carriedSteersConsumed: true });
            h.drive(decide(h.runtime));
            expect(h.turns.at(-1)[0].startsWith(CARRIED_STEERS_WAKE_PROMPT)).toBe(true);
            expect(h.runtime.state.cronSchedule).toMatchObject({ intervalSeconds: 300, reason: "original cron" });
            expect(h.runtime.state.activeTimer).toMatchObject({ type: "cron" });
        });

        it("a follow-up held by an agent wait carries the steers instead of spinning", () => {
            const h = harness({ carriedSteers: [steer(56)] });
            h.runtime.state.pendingPrompt = "spawned agent confirmations";
            h.runtime.state.waitingForAgentIds = ["agent-1"];
            h.runtime.state.activeTimer = {
                type: "agent-poll", deadlineMs: START + 30_000, originalDurationMs: 30_000,
                reason: "waiting for 1 agent(s)", agentIds: ["agent-1"],
            };
            h.drive(drain(h.runtime));
            expect(h.runtime.state.waitingForAgentIds).toBeNull();
            h.results.push({ type: "completed", content: "done", carriedSteersConsumed: true });
            expect(h.drive(decide(h.runtime))).toBe(true);
            expect(h.turns).toHaveLength(1);
            expect(h.turns[0][0]).toContain("spawned agent confirmations");
            expect(h.turns[0][3].carriedSteers).toEqual([steer(56)]);
            expect(h.runtime.state.carriedSteers).toEqual([]);
        });

        it("a carried-only wake keeps its marker when a child digest rides with it", () => {
            const h = harness({ carriedSteers: [steer(55)] });
            h.runtime.state.pendingChildDigest = {
                startedAtMs: START, ready: true,
                updates: [{ sessionId: "child-1", updateType: "completed", content: "child finished" }],
            };
            h.drive(drain(h.runtime));
            h.results.push({ type: "completed", content: "steered", carriedSteersConsumed: true });
            h.drive(decide(h.runtime));
            const [prompt, bootstrap, , meta] = h.turns.at(-1);
            expect(prompt.startsWith(CARRIED_STEERS_WAKE_PROMPT)).toBe(true);
            expect(prompt).toContain("child finished");
            expect(bootstrap).toBe(true);
            expect(meta.carriedSteers).toEqual([steer(55)]);
            expect(h.runtime.state.pendingChildDigest).toBeNull();
        });

        it("a carried-only turn after legacy hydration keeps the resume note as system context", () => {
            const h = harness({
                carriedSteers: [steer(58)], blobEnabled: true, needsHydration: true,
                rehydrationMessage: "Resumed after a lossy handoff.",
            });
            h.run({ type: "completed", content: "steered", carriedSteersConsumed: true }, CARRIED_STEERS_WAKE_PROMPT);
            const [prompt, bootstrap, , meta] = h.turns[0];
            expect(prompt.startsWith(CARRIED_STEERS_WAKE_PROMPT)).toBe(true);
            expect(prompt).toContain("Resumed after a lossy handoff.");
            expect(bootstrap).toBe(true);
            expect(meta.carriedSteers).toEqual([steer(58)]);
            expect(h.runtime.state.pendingRehydrationMessage).toBeUndefined();
        });

        it("a carried-steers wake never merges with another queued bootstrap prompt", () => {
            const h = harness({ carriedSteers: [steer(59)] });
            appendToFifo(h.runtime, [
                { kind: "prompt", prompt: CARRIED_STEERS_WAKE_PROMPT, bootstrap: true, carriedSteersWake: true },
                { kind: "prompt", prompt: "agent kickoff", bootstrap: true },
            ]);
            h.results.push({ type: "completed", content: "steered", carriedSteersConsumed: true });
            h.drive(decide(h.runtime));
            expect(h.turns[0][0].startsWith(CARRIED_STEERS_WAKE_PROMPT)).toBe(true);
            expect(h.turns[0][0]).not.toContain("agent kickoff");
            h.results.push({ type: "completed", content: "kicked off" });
            h.drive(decide(h.runtime));
            expect(h.turns[1][0]).toContain("agent kickoff");
            expect(h.turns[1][3].carriedSteers).toBeUndefined();
        });

        it("a carried-only retry keeps the bootstrap flag of its first attempt", () => {
            const h = harness({ carriedSteers: [steer(57)] });
            h.run({ type: "error", message: "transient", carriedSteersConsumed: true }, CARRIED_STEERS_WAKE_PROMPT);
            const next = h.calls.find(c => c.effect === "can").input;
            const retry = harness(next);
            retry.run({ type: "completed", content: "retry", carriedSteersConsumed: true }, next.prompt);
            expect(retry.turns[0][0].startsWith(CARRIED_STEERS_WAKE_PROMPT)).toBe(true);
            expect(retry.turns[0][1]).toBe(true);
        });
    });

    describe("a retried prompt keeps its client message ids across continue-as-new", () => {
        const canInputs = (h) => h.calls.filter((c) => c.effect === "can").map((c) => c.input);
        const ids = ["cm-1", "cm-2"];

        for (const [name, failure] of [
            ["a thrown turn", new Error("transient worker failure")],
            ["a returned error", { type: "error", message: "model failed" }],
            ["a lost Copilot connection", new Error("Connection is closed.")],
        ]) {
            it(`${name}: the retry's runTurn carries the ids`, () => {
                const h = harness({ blobEnabled: true });
                h.run(failure, "original prompt", ids);
                expect(h.turns[0][3].clientMessageIds).toEqual(ids);
                const [can] = canInputs(h);
                expect(can).toMatchObject({ prompt: "original prompt", retryCount: 1, clientMessageIds: ids });

                const retry = harness(can);
                retry.results.push({ type: "completed", content: "done" });
                retry.drive(decide(retry.runtime));
                expect(retry.turns[0][0]).toBe("original prompt");
                expect(retry.turns[0][3].clientMessageIds).toEqual(ids);
                expect(retry.runtime.state.pendingClientMessageIds).toBeUndefined();
            });
        }

        it("the lossy handoff after the connection retries keeps the ids too", () => {
            let h = harness({ blobEnabled: true });
            h.run(new Error("Connection is closed."), "original prompt", ids);
            for (let attempt = 0; attempt < 10; attempt++) {
                const [can] = canInputs(h);
                expect(can.clientMessageIds).toEqual(ids);
                if (can.retryCount === 0) return;
                h = harness(can);
                h.results.push(new Error("Connection is closed."));
                h.drive(decide(h.runtime));
            }
            throw new Error("no lossy handoff continue-as-new");
        });

        it("the retry keeps the whole prompt envelope: ids, sender and images", () => {
            const sender = { kind: "user", provider: "dev", subject: "alice", display: "Alice" };
            const attachments = [{ filename: "a.png", contentType: "image/png", sizeBytes: 10 }];
            const h = harness({ blobEnabled: true });
            h.results.push(new Error("transient worker failure"));
            h.drive(processPrompt(h.runtime, "look at this", false, undefined, ids, undefined, sender, attachments));
            const [can] = canInputs(h);
            expect(can).toMatchObject({ prompt: "look at this", clientMessageIds: ids, sender, attachments });

            const retry = harness(can);
            retry.results.push({ type: "completed", content: "done" });
            retry.drive(decide(retry.runtime));
            expect(retry.turns[0][3]).toMatchObject({ clientMessageIds: ids, sender, attachments });
            expect(retry.runtime.state.pendingSender).toBeUndefined();
        });

        it("a prompt without ids carries none, and a new prompt never inherits carried ids", () => {
            const h = harness({ blobEnabled: true });
            h.run(new Error("transient worker failure"), "original prompt");
            const [can] = canInputs(h);
            expect(can.clientMessageIds).toBeUndefined();
            const fresh = harness({ clientMessageIds: ["stale"] });
            fresh.run({ type: "completed", content: "fresh" }, "a new prompt", ["cm-new"]);
            expect(fresh.turns[0][3].clientMessageIds).toEqual(["cm-new"]);
        });
    });

    describe("the retry of a thrown turn keeps its turnKey (no double commit)", () => {
        const keyOf = (turn) => turn[3]?.snapshot?.turnKey;
        const canInputs = (h) => h.calls.filter((c) => c.effect === "can").map((c) => c.input);

        it("a throw keeps the key; the retry after continue-as-new sends it again and draws no new GUID; a result clears it", () => {
            const h = harness({ blobEnabled: true });
            h.run(new Error("turn end failed after the commit"));
            const thrownKey = keyOf(h.turns[0]);
            expect(thrownKey).toMatch(/^recorded-guid-/);
            const [can] = canInputs(h);
            expect(can).toMatchObject({ prompt: "original prompt", retryCount: 1, thrownTurnKey: thrownKey });

            const retry = harness(can);
            const guidsBefore = retry.calls.filter((c) => c.effect === "guid").length;
            retry.run({ type: "completed", content: "adopted" }, can.prompt);
            expect(keyOf(retry.turns[0])).toBe(thrownKey);
            expect(retry.calls.filter((c) => c.effect === "guid").length).toBe(guidsBefore);
            expect(retry.runtime.state.thrownTurnKey).toBeNull();

            // The next prompt draws a fresh GUID (this harness's counter restarts, so compare draws).
            retry.run({ type: "completed", content: "next" }, "a new prompt");
            expect(retry.calls.filter((c) => c.effect === "guid").length).toBe(guidsBefore + 1);
        });

        it("a returned error is a result: its retry draws a new key", () => {
            const h = harness({ blobEnabled: true });
            h.run({ type: "error", message: "model failed" });
            const [can] = canInputs(h);
            expect(can.retryCount).toBe(1);
            expect(can.thrownTurnKey).toBeUndefined();
            expect(h.runtime.state.thrownTurnKey).toBeNull();
        });

        it("a new prompt never reuses a carried key (no retry in progress)", () => {
            const h = harness({ blobEnabled: true, retryCount: 0, thrownTurnKey: "recorded-guid-old" });
            h.run({ type: "completed", content: "fresh" }, "a new prompt");
            expect(keyOf(h.turns[0])).not.toBe("recorded-guid-old");
            expect(h.runtime.state.thrownTurnKey).toBeNull();
        });

        it("a give-up drops the key: the next prompt draws a new one", () => {
            const h = harness({ blobEnabled: true, retryCount: 2, thrownTurnKey: "recorded-guid-old" });
            h.run(new Error("turn end failed again"), "original prompt");
            expect(keyOf(h.turns[0])).toBe("recorded-guid-old");
            expect(canInputs(h)).toEqual([]);
            expect(h.runtime.state.retryCount).toBe(0);
            expect(h.runtime.state.thrownTurnKey).toBeNull();
            expect(h.calls.some((c) => c.effect === "manager.updateCmsState" && c.args[4]?.closeControls)).toBe(true);

            h.run({ type: "completed", content: "next" }, "a new prompt");
            expect(keyOf(h.turns[1])).not.toBe("recorded-guid-old");
        });
    });
    describe("a converted queued message (replaced by a delivered steer)", () => {
        const cancelled = (h) => h.calls.flatMap((c) => c.effect === "manager.recordSessionEvent" ? c.args[1] : [])
            .filter((e) => e.eventType === "pending_messages.cancelled").map((e) => e.data);
        const canInputs = (h) => h.calls.filter((c) => c.effect === "can").map((c) => c.input);
        const queued = (id, prompt = "queued text") => ({ prompt, clientMessageIds: [id] });

        it("the result's replaced ids are recorded once as converted_to_steer before any dequeue, and the message never runs", () => {
            const h = harness();
            h.run({ type: "completed", content: "done", replacedClientMessageIds: ["x1"] }, "running prompt", ["y1"]);
            expect(cancelled(h)).toEqual([{ clientMessageIds: ["x1"], reason: "converted_to_steer" }]);
            // Between the turn and its handled result nothing is dequeued: X cannot be dispatched first.
            const turnAt = h.calls.findIndex((c) => c.effect === "session.runTurn");
            const recordAt = h.calls.findIndex((c) => c.effect === "manager.recordSessionEvent"
                && c.args[1].some((e) => e.eventType === "pending_messages.cancelled"));
            expect(turnAt).toBeGreaterThanOrEqual(0);
            expect(recordAt).toBeGreaterThan(turnAt);
            expect(h.calls.slice(turnAt, recordAt).filter((c) => c.effect === "dequeue" || c.effect === "race")).toEqual([]);

            h.messages.push(queued("x1"));
            h.drive(drain(h.runtime));
            expect(h.drive(decide(h.runtime))).toBe(false);
            expect(h.turns).toHaveLength(1);
            expect(cancelled(h)).toHaveLength(1);
            // Consumed: the id leaves the cancel set; a duplicate re-send is caught by the duplicate window.
            expect(h.runtime.state.cancelledMessageIds.has("x1")).toBe(false);
            expect(h.runtime.state.recentClientMessageIds).toContain("x1");
            h.messages.push(queued("x1"));
            h.drive(drain(h.runtime));
            expect(h.drive(decide(h.runtime))).toBe(false);
            expect(h.turns).toHaveLength(1);
        });

        it("a message already in the FIFO is dropped at dispatch", () => {
            const h = harness();
            appendToFifo(h.runtime, [{ kind: "prompt", prompt: "queued text", clientMessageIds: ["x1"] }]);
            h.run({ type: "completed", content: "done", replacedClientMessageIds: ["x1"] });
            h.drive(decide(h.runtime));
            expect(h.turns).toHaveLength(1);
            expect(h.runtime.state.cancelledMessageIds.has("x1")).toBe(false);
        });

        it("an error result's replaced ids survive the retry's continue-as-new", () => {
            const h = harness({ blobEnabled: true });
            h.run({ type: "error", message: "model failed", replacedClientMessageIds: ["x1"] }, "running prompt", ["y1"]);
            const [can] = canInputs(h);
            expect(can.cancelledMessageIds).toEqual(["x1"]);
            const retry = harness(can);
            retry.messages.push(queued("x1"));
            retry.results.push({ type: "completed", content: "retried" });
            retry.drive(decide(retry.runtime));
            retry.drive(drain(retry.runtime));
            retry.drive(decide(retry.runtime));
            expect(retry.turns.map((t) => t[0])).toEqual(["running prompt"]);
        });

        it("a give-up write's replaced ids are dropped the same way", () => {
            const h = harness({ retryCount: 2, updateCmsStateResult: { replacedClientMessageIds: ["x1"] } });
            h.run({ type: "error", message: "transient" }, "running prompt", ["y1"]);
            expect(cancelled(h)).toEqual([{ clientMessageIds: ["x1"], reason: "converted_to_steer" }]);
            h.messages.push(queued("x1"));
            h.drive(drain(h.runtime));
            h.drive(decide(h.runtime));
            expect(h.turns).toHaveLength(1);
        });

        it("a turn without converted steers records no cancellation", () => {
            const h = harness({ retryCount: 2 });
            h.run({ type: "completed", content: "done" });
            h.run({ type: "error", message: "transient" });
            expect(cancelled(h)).toEqual([]);
        });

        it("an ordinary cancel tombstone survives continue-as-new", () => {
            const h = harness();
            h.messages.push({ cancelPending: ["c1"] });
            h.drive(drain(h.runtime));
            const next = buildContinueInput(h.runtime, {});
            expect(next.cancelledMessageIds).toEqual(["c1"]);
            const resumed = harness(next);
            resumed.messages.push(queued("c1"));
            resumed.drive(drain(resumed.runtime));
            expect(resumed.drive(decide(resumed.runtime))).toBe(false);
            expect(resumed.turns).toEqual([]);
        });

        it("the cancel set keeps the newest 200 ids: 200 waiting prompts are all dropped, a 201st evicts the oldest", () => {
            const ids = (n) => Array.from({ length: n }, (_, i) => `c${i}`);
            const all = harness();
            all.messages.push({ cancelPending: ids(200) });
            all.drive(drain(all.runtime));
            const kept = harness(buildContinueInput(all.runtime, {}));
            expect(kept.runtime.state.cancelledMessageIds.size).toBe(200);
            for (const id of ids(200)) kept.messages.push(queued(id, `text ${id}`));
            kept.drive(drain(kept.runtime));
            expect(kept.drive(decide(kept.runtime))).toBe(false);
            expect(kept.turns).toEqual([]);

            const over = harness();
            over.messages.push({ cancelPending: ids(201) });
            over.drive(drain(over.runtime));
            expect(over.runtime.state.cancelledMessageIds.has("c0")).toBe(false);
            expect(over.runtime.state.cancelledMessageIds.size).toBe(200);
            const next = buildContinueInput(over.runtime, {});
            expect(next.cancelledMessageIds).toHaveLength(200);
            expect(next.cancelledMessageIds[0]).toBe("c1");
            const resumed = harness(next);
            resumed.messages.push(queued("c0", "evicted"), queued("c1", "kept"));
            resumed.results.push({ type: "completed", content: "ran" });
            resumed.drive(drain(resumed.runtime));
            resumed.drive(decide(resumed.runtime));
            expect(resumed.turns.map((t) => t[0])).toEqual(["evicted"]);
        });
    });
});
