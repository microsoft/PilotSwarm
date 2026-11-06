/**
 * Retry exhaustion must leave the failure ON THE SESSION ROW.
 *
 * Before 1.0.69, exhausting the generic retry loop only published a
 * transient status; the next park wiped it and the session settled `idle`
 * with no error and a silently lost prompt (2026-08-24 campaign, found
 * live: a session whose provider credential broke ended clean-looking).
 *
 * This drives the REAL latest generator with a runTurn that THROWS, across
 * the continue-as-new retry chain, and asserts the exhaustion branch yields
 * updateCmsState("error", "Failed after N attempts: …"). Verified red with
 * the row write removed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    isProviderRateLimitError,
    providerRateLimitDelayMs,
    PROVIDER_RATE_LIMIT_WAIT_BUDGET_MS,
} from "../../src/orchestration/provider-rate-limit.ts";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

const INITIAL_NOW = 1_750_000_000_000;

function createThrowingHarness({ turnResults = null, initialQueue, initialNow = INITIAL_NOW } = {}) {
    const turns = [];
    const cmsStateCalls = [];
    const parentMessages = [];
    const statusSignals = [];
    const scheduleTimers = [];
    const script = turnResults ? [...turnResults] : null;
    const queue = initialQueue ?? [JSON.stringify({ prompt: "hello there", clientMessageIds: ["cm-x"] })];

    mockSession = new Proxy({}, {
        get: (_t, prop) => {
            if (prop === "runTurn") {
                return (prompt, bootstrap, turnIndex, opts) => {
                    turns.push({ prompt, turnIndex, opts: opts ?? {} });
                    return { effect: "runTurn" };
                };
            }
            return (...args) => ({ effect: `session.${String(prop)}`, args });
        },
    });
    mockManager = new Proxy({}, {
        get: (_t, prop) => (...args) => ({ effect: `manager.${String(prop)}`, args }),
    });

    const values = new Map();
    const ctx = {
        traceInfo: () => {},
        setCustomStatus: (value) => statusSignals.push(JSON.parse(value)),
        getValue: (k) => (values.has(k) ? values.get(k) : null),
        setValue: (k, v) => values.set(k, v),
        clearValue: (k) => values.delete(k),
        utcNow: () => ({ effect: "utcNow" }),
        newGuid: () => ({ effect: "newGuid" }),
        scheduleTimer: (ms) => {
            scheduleTimers.push(ms);
            return { effect: "scheduleTimer", ms };
        },
        dequeueEvent: (name) => ({ effect: "dequeueEvent", name }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "continueAsNew", input, version }),
        hasQueuedEvents: () => queue.length > 0,
    };

    let now = initialNow;
    // resolve returns { throwError } when the generator must see a rejection.
    const resolve = (effect) => {
        if (!effect || typeof effect !== "object") return undefined;
        switch (effect.effect) {
            case "utcNow": return (now += 1000);
            case "newGuid": return "00000000-0000-0000-0000-000000000001";
            case "dequeueEvent": {
                if (queue.length === 0) throw new Error("dequeue underflow");
                return queue.shift();
            }
            case "runTurn":
                // 1.0.81 yields the turn directly; it no longer races a Stop
                // queue. Scripted results are RETURNED (the activity caught
                // the failure itself); without a script the turn THROWS.
                if (script) {
                    if (script.length === 0) throw new Error("runTurn past the script");
                    return script.shift();
                }
                return { throwError: new Error("LLM endpoint exploded") };
            case "race": {
                const sides = [effect.left, effect.right];
                const dequeueIx = sides.findIndex((s) => s?.effect === "dequeueEvent");
                if (dequeueIx >= 0 && queue.length > 0) {
                    return { index: dequeueIx, value: queue.shift() };
                }
                const timerIx = sides.findIndex((s) => s?.effect === "scheduleTimer");
                if (timerIx >= 0 && sides[timerIx].ms <= 1000) return { index: timerIx };
                return { effect: "PARKED" };
            }
            default:
                if (effect.effect === "manager.updateCmsState") {
                    cmsStateCalls.push(effect.args);
                    return undefined;
                }
                if (effect.effect === "manager.sendToSession") {
                    parentMessages.push(effect.args);
                    return undefined;
                }
                if (effect.effect === "manager.getWorkerSessionPolicy") {
                    return { policy: null, allowedAgentNames: [] };
                }
                if (effect.effect === "manager.resolveAgentConfig") return null;
                if (effect.effect === "manager.listModels") return [];
                if (effect.effect === "manager.loadKnowledgeIndex") return null;
                if (effect.effect === "manager.getSessionStatus") return null;
                if (effect.effect === "manager.getOrchestrationStats") return null;
                if (effect.effect === "manager.listChildSessions") return [];
                return undefined;
        }
    };

    return { ctx, turns, cmsStateCalls, parentMessages, statusSignals, scheduleTimers, resolve };
}

async function latestHandler() {
    const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
    const mod = await import("../../src/orchestration.ts");
    const fn = mod[`durableSessionOrchestration_${DURABLE_SESSION_LATEST_VERSION.replace(/\./g, "_")}`];
    expect(fn, `latest handler for ${DURABLE_SESSION_LATEST_VERSION}`).toBeTypeOf("function");
    return fn;
}

/** Run until park, continue-as-new, or return — throwing scripted rejections in. */
function drive(gen, harness, { maxSteps = 400 } = {}) {
    let input;
    let pendingThrow = null;
    for (let i = 0; i < maxSteps; i += 1) {
        const next = pendingThrow ? gen.throw(pendingThrow) : gen.next(input);
        pendingThrow = null;
        if (next.done) return { kind: "return", value: next.value };
        const effect = next.value;
        if (effect?.effect === "continueAsNew") {
            return { kind: "continueAsNew", input: effect.input, version: effect.version };
        }
        if (effect?.effect === "dequeueEvent" && !harness.ctx.hasQueuedEvents()) {
            return { kind: "blocked" };
        }
        const resolved = harness.resolve(effect);
        if (resolved?.throwError) { pendingThrow = resolved.throwError; input = undefined; continue; }
        input = resolved;
        if (input?.effect === "PARKED") return { kind: "parked" };
    }
    throw new Error("drive exceeded step limit");
}

const INPUT = (overrides = {}) => ({
    sessionId: "exhaustion-test",
    config: { model: "azure-openai:gpt-5.4-mini" },
    iteration: 0,
    isSystem: false,
    blobEnabled: false,
    ...overrides,
});

describe("generic retry exhaustion (orchestration 1.0.69)", () => {
    beforeEach(() => { mockSession = null; mockManager = null; });

    it("classifies provider throttling and computes stable waits beyond the reported 67-second reset", () => {
        expect(isProviderRateLimitError("Execution failed: request returned HTTP 429")).toBe(true);
        expect(isProviderRateLimitError("Too many requests; provider rate limit exceeded")).toBe(true);
        expect(isProviderRateLimitError("rate_limit_exceeded")).toBe(true);
        expect(isProviderRateLimitError("too_many_requests")).toBe(true);
        expect(isProviderRateLimitError("provider melted (HTTP 503)")).toBe(false);

        const firstWait = providerRateLimitDelayMs("session-a", 1);
        expect(firstWait).toBe(providerRateLimitDelayMs("session-a", 1));
        expect(firstWait).toBeGreaterThanOrEqual(67_500);
        expect(firstWait).toBeLessThanOrEqual(5 * 60_000);
        expect(providerRateLimitDelayMs("session-a", 2)).toBeGreaterThan(firstWait);
    });

    it("waits durably on a returned 429, recovers, and starts a fresh budget for the next prompt", async () => {
        const handler = await latestHandler();
        const rateLimit = {
            type: "error",
            message: "Execution failed: rate_limit_exceeded; token rate limit exceeded",
        };
        const firstHarness = createThrowingHarness({ turnResults: [rateLimit] });
        const first = drive(handler(firstHarness.ctx, INPUT()), firstHarness);

        expect(first.kind).toBe("continueAsNew");
        expect(first.version).toBe("1.0.83");
        expect(first.input.providerRateLimitRetryCount).toBe(1);
        expect(first.input.providerRateLimitStartedAtMs).toBeGreaterThan(0);
        expect(first.input.retryCount).toBe(0);
        expect(first.input.prompt).toBe("hello there");
        expect(first.input.clientMessageIds).toEqual(["cm-x"]);
        expect(firstHarness.scheduleTimers.at(-1)).toBe(
            providerRateLimitDelayMs("exhaustion-test", 1),
        );
        expect(firstHarness.statusSignals.find((signal) => signal.status === "waiting")).toMatchObject({
            providerRateLimitRetry: 1,
            waitReason: expect.stringContaining("provider rate limit"),
        });
        expect(firstHarness.cmsStateCalls).toContainEqual([
            "exhaustion-test",
            "waiting",
            null,
            expect.stringContaining("provider rate limit"),
        ]);

        const secondHarness = createThrowingHarness({
            turnResults: [{ type: "completed", content: "recovered" }, rateLimit],
            initialQueue: [JSON.stringify({ prompt: "follow-up" })],
            initialNow: first.input.providerRateLimitStartedAtMs + 180_000,
        });
        const second = drive(handler(secondHarness.ctx, INPUT(first.input)), secondHarness);

        expect(second.kind).toBe("continueAsNew");
        expect(secondHarness.turns).toHaveLength(2);
        expect(second.input.providerRateLimitRetryCount).toBe(1);
        expect(second.input.providerRateLimitStartedAtMs).toBeGreaterThan(first.input.providerRateLimitStartedAtMs);
        expect(secondHarness.scheduleTimers.at(-1)).toBe(
            providerRateLimitDelayMs("exhaustion-test", 1),
        );
    });

    it("keeps repeated 429s on the rate-limit budget instead of exhausting generic retries", async () => {
        const handler = await latestHandler();
        const rateLimit = {
            type: "error",
            message: "Execution failed: rate_limit_exceeded; token rate limit exceeded",
        };
        let input = INPUT();

        for (let attempt = 1; attempt <= 4; attempt += 1) {
            const harness = createThrowingHarness({ turnResults: [rateLimit] });
            const out = drive(handler(harness.ctx, INPUT(input)), harness);
            expect(out.kind).toBe("continueAsNew");
            expect(out.input.providerRateLimitRetryCount).toBe(attempt);
            expect(out.input.retryCount).toBe(0);
            expect(harness.cmsStateCalls.some(([, state]) => state === "error")).toBe(false);
            input = out.input;
        }
    });

    it("stops on a thrown 429 after the 30-minute budget and persists the final error", async () => {
        const handler = await latestHandler();
        const harness = createThrowingHarness({
            turnResults: [{ throwError: new Error("Request failed (HTTP 429)") }],
        });
        const out = drive(handler(harness.ctx, INPUT({
            providerRateLimitRetryCount: 1,
            providerRateLimitStartedAtMs: INITIAL_NOW - PROVIDER_RATE_LIMIT_WAIT_BUDGET_MS - 5_000,
        })), harness);

        expect(out.kind).not.toBe("continueAsNew");
        expect(harness.scheduleTimers.some((waitMs) => waitMs >= 60_000)).toBe(false);
        const errorWrites = harness.cmsStateCalls.filter(([, state]) => state === "error");
        expect(errorWrites).toHaveLength(1);
        expect(String(errorWrites[0][2])).toContain("Provider rate-limit retry budget exhausted after 30 minutes");
        expect(String(errorWrites[0][2])).toContain("HTTP 429");
        expect(harness.statusSignals.findLast((signal) => signal.status === "error")).toMatchObject({
            retriesExhausted: true,
        });
    });

    it("after the last retry the failure lands on the session row, not just the status plane", async () => {
        const handler = await latestHandler();

        // Attempt 1: throw → continue-as-new with retryCount 1.
        let harness = createThrowingHarness();
        let out = drive(handler(harness.ctx, INPUT()), harness);
        expect(out.kind).toBe("continueAsNew");
        expect(out.input.retryCount).toBe(1);
        expect(harness.cmsStateCalls.some(([, state]) => state === "error")).toBe(false);

        // Attempt 2.
        harness = createThrowingHarness();
        out = drive(handler(harness.ctx, INPUT(out.input)), harness);
        expect(out.kind).toBe("continueAsNew");
        expect(out.input.retryCount).toBe(2);

        // Attempt 3 = MAX_RETRIES: the exhaustion branch. No further CAN —
        // the session parks waiting for input, and the ROW must say why.
        harness = createThrowingHarness();
        out = drive(handler(harness.ctx, INPUT(out.input)), harness);
        expect(out.kind).not.toBe("continueAsNew");
        const errorWrites = harness.cmsStateCalls.filter(([, state]) => state === "error");
        expect(errorWrites.length).toBeGreaterThanOrEqual(1);
        const [, , lastError] = errorWrites[errorWrites.length - 1];
        expect(String(lastError)).toMatch(/Failed after 3 attempts/);
        expect(String(lastError)).toMatch(/LLM endpoint exploded/);
    });

    it("a RETURNED error result accumulates retries across continue-as-new instead of looping at 1/3 for ever", async () => {
        // The storm the regression workflow caught live: the activity caught
        // the provider failure and RETURNED {type:"error"}; the blanket
        // retryCount reset then wiped the carried count every cycle, so the
        // counter read 1/3 for ever and exhaustion was unreachable.
        const handler = await latestHandler();
        const errResult = { type: "error", message: "provider melted (HTTP 503)" };

        let harness = createThrowingHarness({ turnResults: [errResult] });
        let out = drive(handler(harness.ctx, INPUT()), harness);
        expect(out.kind).toBe("continueAsNew");
        expect(out.input.retryCount).toBe(1);

        harness = createThrowingHarness({ turnResults: [errResult] });
        out = drive(handler(harness.ctx, INPUT(out.input)), harness);
        expect(out.kind).toBe("continueAsNew");
        expect(out.input.retryCount).toBe(2);

        harness = createThrowingHarness({ turnResults: [errResult] });
        out = drive(handler(harness.ctx, INPUT(out.input)), harness);
        expect(out.kind).not.toBe("continueAsNew");
        const errorWrites = harness.cmsStateCalls.filter(([, state]) => state === "error");
        const [, , lastError] = errorWrites[errorWrites.length - 1];
        expect(String(lastError)).toMatch(/Failed after 3 attempts/);
    });

    it("a returned transient error preserves the initial required tool on retry", async () => {
        const handler = await latestHandler();
        const errResult = { type: "error", message: "provider melted (HTTP 503)" };
        const harness = createThrowingHarness({ turnResults: [errResult] });

        const out = drive(handler(harness.ctx, INPUT({
            requiredTool: "package_catalog",
        })), harness);

        expect(out.kind).toBe("continueAsNew");
        expect(harness.turns[0].opts.requiredTool).toBe("package_catalog");
        expect(out.input.requiredTool).toBe("package_catalog");
        expect(Object.hasOwn(out.input.config, "initialRequiredTool")).toBe(false);
    });

    it("a RETURNED auth failure stops immediately with the fix-your-key hint, like the thrown one always did", async () => {
        const handler = await latestHandler();
        const authResult = { type: "error", message: "Authentication failed with provider (HTTP 401)" };

        const harness = createThrowingHarness({ turnResults: [authResult] });
        const out = drive(handler(harness.ctx, INPUT()), harness);
        // No retry cycle: no continue-as-new, and the row carries the
        // actionable auth hint.
        expect(out.kind).not.toBe("continueAsNew");
        const errorWrites = harness.cmsStateCalls.filter(([, state]) => state === "error");
        expect(errorWrites.length).toBeGreaterThanOrEqual(1);
        const [, , lastError] = errorWrites[errorWrites.length - 1];
        expect(String(lastError)).toMatch(/Authentication failed/);
        expect(String(lastError)).toMatch(/update your GitHub Copilot key|rejected the authentication token/);
    });

    it("a non-retryable required-tool failure stops without a continue-as-new retry", async () => {
        const handler = await latestHandler();
        const contractResult = {
            type: "error",
            message: 'Required tool "package_catalog" was not invoked after 2 attempts.',
            retryable: false,
        };

        const harness = createThrowingHarness({ turnResults: [contractResult] });
        const out = drive(handler(harness.ctx, INPUT()), harness);

        expect(out.kind).not.toBe("continueAsNew");
        expect(harness.turns).toHaveLength(1);
        const errorWrites = harness.cmsStateCalls.filter(([, state]) => state === "error");
        expect(errorWrites).toHaveLength(1);
        expect(String(errorWrites[0][2])).toContain("package_catalog");
    });

    it("a child reports a non-retryable required-tool failure to its parent", async () => {
        const handler = await latestHandler();
        const contractResult = {
            type: "error",
            message: 'Required tool "package_catalog" was not invoked after 2 attempts.',
            retryable: false,
        };
        const harness = createThrowingHarness({ turnResults: [contractResult] });

        const out = drive(handler(harness.ctx, INPUT({ parentSessionId: "parent-session" })), harness);

        expect(out.kind).not.toBe("continueAsNew");
        expect(harness.parentMessages).toHaveLength(1);
        expect(harness.parentMessages[0][0]).toBe("parent-session");
        expect(harness.parentMessages[0][1]).toContain("type=failed");
        expect(harness.parentMessages[0][1]).toContain("verdict=failed");
        expect(harness.parentMessages[0][1]).toContain("package_catalog");
    });
});
