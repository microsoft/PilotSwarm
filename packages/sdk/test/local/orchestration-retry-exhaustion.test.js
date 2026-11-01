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

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

function createThrowingHarness({ turnResults = null, errorMessage = "LLM endpoint exploded" } = {}) {
    const turns = [];
    const cmsStateCalls = [];
    const parentMessages = [];
    const statuses = [];
    const timers = [];
    const events = [];
    const script = turnResults ? [...turnResults] : null;
    const queue = [JSON.stringify({ prompt: "hello there", clientMessageIds: ["cm-x"] })];

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
        setCustomStatus: (status) => statuses.push(JSON.parse(status)),
        getValue: (k) => (values.has(k) ? values.get(k) : null),
        setValue: (k, v) => values.set(k, v),
        clearValue: (k) => values.delete(k),
        utcNow: () => ({ effect: "utcNow" }),
        newGuid: () => ({ effect: "newGuid" }),
        scheduleTimer: (ms) => { timers.push(ms); return { effect: "scheduleTimer", ms }; },
        dequeueEvent: (name) => ({ effect: "dequeueEvent", name }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "continueAsNew", input, version }),
        hasQueuedEvents: () => queue.length > 0,
    };

    let now = 1_750_000_000_000;
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
                return { throwError: new Error(errorMessage) };
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
                if (effect.effect === "manager.recordSessionEvent") {
                    events.push(...effect.args[1]);
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

    return { ctx, turns, cmsStateCalls, parentMessages, statuses, timers, events, resolve };
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

describe("compute failure retry classification", () => {
    for (const returned of [false, true]) {
        it(`${returned ? "returned" : "thrown"} permanent compute failure stops immediately and keeps its reason when parked`, async () => {
            const message = "COMPUTE_TARGET_NOT_FOUND: target was deleted";
            const harness = createThrowingHarness({ errorMessage: message, turnResults: returned ? [{ type: "error", message }] : null });
            const out = drive((await latestHandler())(harness.ctx, INPUT()), harness);
            expect(out.kind).not.toBe("continueAsNew");
            expect(harness.turns).toHaveLength(1);
            expect(harness.timers).not.toContain(15_000);
            expect(harness.cmsStateCalls.filter(([, state]) => state === "error")).toHaveLength(1);
            const failureEvent = harness.events.find(event => event.eventType === "session.compute_failure");
            expect(failureEvent).toBeDefined();
            expect(failureEvent.data).toMatchObject({ code: "COMPUTE_TARGET_NOT_FOUND", permanent: true });
            const status = harness.statuses.at(-1);
            expect(status.computeFailure).toEqual({ code: "COMPUTE_TARGET_NOT_FOUND", permanent: true });
            expect(status.error).toContain("Choose an available compute target");
            expect(status.error).toContain("target was deleted");
        });

        it(`${returned ? "returned" : "thrown"} temporary compute failure retains all retries and an accurate reason`, async () => {
            const message = "COMPUTE_UNAVAILABLE: host offline; HTTP 401";
            let input = INPUT();
            for (let attempt = 1; attempt <= 3; attempt++) {
                const harness = createThrowingHarness({ errorMessage: message, turnResults: returned ? [{ type: "error", message, retryable: false }] : null });
                const out = drive((await latestHandler())(harness.ctx, input), harness);
                expect(harness.statuses.some(status => status.error?.includes("host offline"))).toBe(true);
                expect(harness.statuses.some(status => status.error?.includes("start it"))).toBe(true);
                if (attempt < 3) {
                    expect(out.kind).toBe("continueAsNew");
                    expect(out.input.retryCount).toBe(attempt);
                    expect(harness.timers).toContain(attempt === 1 ? 15_000 : 30_000);
                    input = INPUT(out.input);
                } else {
                    expect(out.kind).not.toBe("continueAsNew");
                    expect(harness.cmsStateCalls.find(([, state]) => state === "error")[2]).toContain("Failed after 3 attempts");
                }
            }
        });
    }

    it("ordinary success, authentication failure, and generic retry have the frozen version's durable schedule", async () => {
        const { durableSessionOrchestration_1_0_82: frozen } = await import("../../src/orchestration_1_0_82/index.ts");
        const latest = await latestHandler();
        const normalized = value => JSON.parse(JSON.stringify(value).replaceAll("1.0.82", "VERSION").replaceAll("1.0.83", "VERSION"));
        for (const options of [
            { turnResults: [{ type: "completed", content: "ordinary answer" }] },
            { errorMessage: "ordinary provider outage" },
            { errorMessage: "Authentication failed (HTTP 401)" },
        ]) {
            const traces = [];
            for (const handler of [frozen, latest]) {
                const harness = createThrowingHarness(options);
                const effects = [];
                const resolve = harness.resolve;
                harness.resolve = effect => { effects.push(effect); return resolve(effect); };
                const out = drive(handler(harness.ctx, INPUT()), harness);
                traces.push(normalized({ out, effects, statuses: harness.statuses }));
            }
            expect(traces[1]).toEqual(traces[0]);
        }
    });
});

describe("generic retry exhaustion (orchestration 1.0.69)", () => {
    beforeEach(() => { mockSession = null; mockManager = null; });

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
