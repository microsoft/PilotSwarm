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
    const runtime = drive(createRuntime(ctx, {
        sessionId: "turn-control-fixture",
        config: {},
        iteration: 4,
        isSystem: true,
        blobEnabled: false,
        ...overrides,
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
});
