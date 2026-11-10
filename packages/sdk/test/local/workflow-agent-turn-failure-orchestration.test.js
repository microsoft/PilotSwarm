/**
 * PR 270 (owner decision): session orchestration 1.0.83 reports a Workflow agent chat's turn that fails for good
 * (orchestration/workflow-turn-failure.ts), so the agent step fails execution_failed instead of waiting for its deadline.
 *
 * This drives the REAL latest generator (as orchestration-retry-exhaustion.test.js does) with the session and manager
 * proxies mocked: each yielded activity is an effect the harness answers. The report is the manager's
 * reportWorkflowAgentTurnFailure effect. What is checked (the formal OwnedRetry cases: or.terminal-report,
 * or.terminal-report-can, fault.or-report-on-retry):
 *
 * - The report is made once, at the terminal failure (retries spent, a credential failure, a non-retryable error), after
 *   the session row says error, with the failed turn's prompt ids; never while a retry is owed (attempts 1 and 2).
 * - A session that is not an agent chat (its id is not one) makes no report, so its history is unchanged.
 * - A report whose activity fails stays owed: a continue-as-new carries it, the next execution makes it at its start,
 *   and while it still fails it is made again before the next turn; a turn that succeeds drops it.
 *
 * At 01caf109 no report is made at all, so every case here fails there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workflowAgentChatSessionId, workflowAgentChildSessionId } from "../../src/workflow/v2/agent-ids.ts";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

const WF = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const NX = `nx-${"a1".repeat(20)}`;
/** A visit's own chat (chat: new) and a continued chat: both are agent chats' ids (version 8). */
const AGENT_CHAT = workflowAgentChildSessionId(NX);
const CONTINUED_CHAT = workflowAgentChatSessionId(RUN, "talk");
/** The visit's prompt id, as the controller's spawn sends it (workflowAgentClientMessageId). */
const PROMPT_ID = `workflow:${WF}:${RUN}:agent:${NX}`;
const REPORT = "manager.reportWorkflowAgentTurnFailure";

/**
 * The harness: `turnResults` are returned by the turns in order (none: each turn throws); `reportFails` makes the report
 * activity fail; `later` messages are delivered one at a time when the session blocks on its queue.
 */
function createHarness({ turnResults = null, reportFails = false, later = [], prompt = { prompt: "do the step", clientMessageIds: [PROMPT_ID] } } = {}) {
    const turns = [];
    const effects = [];
    const reports = [];
    const cmsStateCalls = [];
    const script = turnResults ? [...turnResults] : null;
    const queue = prompt ? [JSON.stringify(prompt)] : [];
    const pendingLater = later.map(message => JSON.stringify(message));

    mockSession = new Proxy({}, {
        get: (_t, prop) => {
            if (prop === "runTurn") {
                return (text, bootstrap, turnIndex, opts) => {
                    turns.push({ prompt: text, turnIndex, opts: opts ?? {} });
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
        traceWarn: () => {},
        setCustomStatus: () => {},
        getValue: (k) => (values.has(k) ? values.get(k) : null),
        setValue: (k, v) => values.set(k, v),
        clearValue: (k) => values.delete(k),
        utcNow: () => ({ effect: "utcNow" }),
        newGuid: () => ({ effect: "newGuid" }),
        scheduleTimer: (ms) => ({ effect: "scheduleTimer", ms }),
        dequeueEvent: (name) => ({ effect: "dequeueEvent", name }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "continueAsNew", input, version }),
        hasQueuedEvents: () => queue.length > 0 || pendingLater.length > 0,
    };

    let now = 1_750_000_000_000;
    const resolve = (effect) => {
        if (!effect || typeof effect !== "object") return undefined;
        if (typeof effect.effect === "string" && (effect.effect.startsWith("manager.") || effect.effect === "runTurn")) effects.push(effect.effect);
        switch (effect.effect) {
            case "utcNow": return (now += 1000);
            case "newGuid": return "00000000-0000-0000-0000-000000000001";
            case "dequeueEvent": {
                if (queue.length > 0) return queue.shift();
                if (pendingLater.length > 0) return pendingLater.shift();
                throw new Error("dequeue underflow");
            }
            case "runTurn":
                if (script) {
                    if (script.length === 0) throw new Error("runTurn past the script");
                    return script.shift();
                }
                return { throwError: new Error("exceeded token rate limit") };
            case "race": {
                const sides = [effect.left, effect.right];
                const dequeueIx = sides.findIndex((s) => s?.effect === "dequeueEvent");
                if (dequeueIx >= 0 && queue.length > 0) return { index: dequeueIx, value: queue.shift() };
                const timerIx = sides.findIndex((s) => s?.effect === "scheduleTimer");
                if (timerIx >= 0 && sides[timerIx].ms <= 1000) return { index: timerIx };
                if (dequeueIx >= 0 && pendingLater.length > 0) return { index: dequeueIx, value: pendingLater.shift() };
                return { effect: "PARKED" };
            }
            default:
                if (effect.effect === REPORT) {
                    reports.push(effect.args[0]);
                    if (reportFails) return { throwError: new Error("the workflow store is unreachable") };
                    return { decided: [NX], reason: "decided" };
                }
                if (effect.effect === "manager.updateCmsState") {
                    cmsStateCalls.push(effect.args);
                    return undefined;
                }
                if (effect.effect === "manager.getWorkerSessionPolicy") return { policy: null, allowedAgentNames: [] };
                if (effect.effect === "manager.resolveAgentConfig") return null;
                if (effect.effect === "manager.listModels") return [];
                if (effect.effect === "manager.loadKnowledgeIndex") return null;
                if (effect.effect === "manager.getSessionStatus") return null;
                if (effect.effect === "manager.getOrchestrationStats") return null;
                if (effect.effect === "manager.listChildSessions") return [];
                return undefined;
        }
    };

    return { ctx, turns, effects, reports, cmsStateCalls, resolve };
}

async function latestHandler() {
    const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
    const mod = await import("../../src/orchestration.ts");
    const fn = mod[`durableSessionOrchestration_${DURABLE_SESSION_LATEST_VERSION.replace(/\./g, "_")}`];
    expect(fn, `latest handler for ${DURABLE_SESSION_LATEST_VERSION}`).toBeTypeOf("function");
    return fn;
}

/** Run until park, continue-as-new, or return, throwing scripted rejections in. */
function drive(gen, harness, { maxSteps = 600 } = {}) {
    let input;
    let pendingThrow = null;
    for (let i = 0; i < maxSteps; i += 1) {
        const next = pendingThrow ? gen.throw(pendingThrow) : gen.next(input);
        pendingThrow = null;
        if (next.done) return { kind: "return", value: next.value };
        const effect = next.value;
        if (effect?.effect === "continueAsNew") return { kind: "continueAsNew", input: effect.input, version: effect.version };
        if (effect?.effect === "dequeueEvent" && !harness.ctx.hasQueuedEvents()) return { kind: "blocked" };
        const resolved = harness.resolve(effect);
        if (resolved?.throwError) { pendingThrow = resolved.throwError; input = undefined; continue; }
        input = resolved;
        if (input?.effect === "PARKED") return { kind: "parked" };
    }
    throw new Error("drive exceeded step limit");
}

const INPUT = (overrides = {}) => ({
    sessionId: AGENT_CHAT,
    config: { model: "azure-openai:gpt-5.4-mini" },
    iteration: 0,
    isSystem: false,
    blobEnabled: false,
    ...overrides,
});

/** Drive the three attempts of a turn that always throws; returns the third attempt's harness and outcome. */
async function exhaust(sessionId, { reportFails = false } = {}) {
    const handler = await latestHandler();
    const attempts = [];
    let input = INPUT({ sessionId });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const harness = createHarness({ reportFails });
        const out = drive(handler(harness.ctx, input), harness);
        attempts.push({ harness, out });
        if (out.kind === "continueAsNew") input = INPUT({ ...out.input, sessionId });
    }
    return attempts;
}

describe("a Workflow agent chat's failed turn is reported (orchestration 1.0.83, PR 270)", () => {
    beforeEach(() => { mockSession = null; mockManager = null; });

    it("retries spent: one report at the terminal failure, after the row says error, never while a retry is owed", async () => {
        const [first, second, third] = await exhaust(AGENT_CHAT);
        // fault.or-report-on-retry: attempts 1 and 2 owe a retry (continue-as-new) and report nothing.
        expect(first.out.kind).toBe("continueAsNew");
        expect(second.out.kind).toBe("continueAsNew");
        expect(first.harness.reports).toEqual([]);
        expect(second.harness.reports).toEqual([]);
        expect(first.out.input.workflowTurnFailure).toBeUndefined();
        expect(second.out.input.workflowTurnFailure).toBeUndefined();
        // or.terminal-report: attempt 3 reports once, with the failed turn's prompt id and its cause, after the error row.
        expect(third.out.kind).not.toBe("continueAsNew");
        expect(third.harness.reports).toEqual([{ sessionId: AGENT_CHAT, clientMessageIds: [PROMPT_ID], cause: expect.stringMatching(/^Failed after 3 attempts: .*exceeded token rate limit/) }]);
        const errorWrite = third.harness.effects.lastIndexOf("manager.updateCmsState");
        expect(errorWrite).toBeGreaterThanOrEqual(0);
        expect(third.harness.effects.indexOf(REPORT)).toBeGreaterThan(errorWrite);
        expect(third.harness.effects.filter(effect => effect === REPORT)).toHaveLength(1);
    });

    it("a continued chat reports too; a session that is not an agent chat reports nothing", async () => {
        const [, , continued] = await exhaust(CONTINUED_CHAT);
        expect(continued.harness.reports).toEqual([expect.objectContaining({ sessionId: CONTINUED_CHAT, clientMessageIds: [PROMPT_ID] })]);
        const plain = await exhaust("exhaustion-test");
        for (const { harness } of plain) expect(harness.reports).toEqual([]);
    });

    it("a credential failure and a non-retryable error report at once, without a retry", async () => {
        const handler = await latestHandler();
        for (const result of [
            { type: "error", message: "Authentication failed with provider (HTTP 401)" },
            { type: "error", message: 'Required tool "complete_workflow_node" was not invoked after 2 attempts.', retryable: false },
        ]) {
            const harness = createHarness({ turnResults: [result] });
            const out = drive(handler(harness.ctx, INPUT()), harness);
            expect(out.kind).not.toBe("continueAsNew");
            expect(harness.turns).toHaveLength(1);
            expect(harness.reports).toEqual([{ sessionId: AGENT_CHAT, clientMessageIds: [PROMPT_ID], cause: expect.any(String) }]);
            expect(harness.reports[0].cause).toContain(result.message.slice(0, 20));
        }
    });

    it("or.terminal-report-can: a report whose activity fails stays owed, rides continue-as-new, and is made at the next execution's start", async () => {
        const [, , third] = await exhaust(AGENT_CHAT, { reportFails: true });
        expect(third.harness.reports).toHaveLength(1);
        // The execution's own continue-as-new carries it (versionedContinueAsNew), whatever input it builds.
        const { createInitialState, deriveOptions } = await import("../../src/orchestration/state.ts");
        const { continueInput, versionedContinueAsNew } = await import("../../src/orchestration/lifecycle.ts");
        const owed = { clientMessageIds: [PROMPT_ID], cause: "Failed after 3 attempts: exceeded token rate limit" };
        const input = INPUT({ workflowTurnFailure: owed });
        const options = deriveOptions(input);
        const state = createInitialState(input, options);
        expect(state.workflowTurnFailure).toEqual(owed);
        const harness = createHarness();
        const runtime = { ctx: harness.ctx, input, versions: { currentVersion: "1.0.83", latestVersion: "1.0.83" }, manager: mockManager,
            session: mockSession, state, options };
        const can = versionedContinueAsNew(runtime, continueInput(runtime)).next().value;
        expect(can.effect).toBe("continueAsNew");
        expect(can.input.workflowTurnFailure).toEqual(owed);
        state.workflowTurnFailure = null;
        expect(versionedContinueAsNew(runtime, continueInput(runtime)).next().value.input).not.toHaveProperty("workflowTurnFailure");

        // The next execution makes it at its start, before any turn, once; made, it is owed no more.
        const handler = await latestHandler();
        const next = createHarness({ turnResults: [{ type: "completed", content: "ok" }] });
        drive(handler(next.ctx, input), next);
        expect(next.reports).toEqual([{ sessionId: AGENT_CHAT, ...owed }]);
        expect(next.effects.indexOf(REPORT)).toBeLessThan(next.effects.indexOf("runTurn"));
    });

    it("while its activity still fails it is made again before the next turn; a turn that succeeds drops it (no report after a success)", async () => {
        const handler = await latestHandler();
        const owed = { clientMessageIds: [PROMPT_ID], cause: "Failed after 3 attempts: exceeded token rate limit" };
        const harness = createHarness({
            reportFails: true,
            turnResults: [{ type: "completed", content: "ok" }, { type: "completed", content: "ok again" }],
            later: [{ prompt: "and now?", clientMessageIds: ["cm-later"] }],
        });
        drive(handler(harness.ctx, INPUT({ workflowTurnFailure: owed })), harness);
        expect(harness.turns).toHaveLength(2);
        // At the execution's start and before the first turn; the first turn succeeded, so none before the second.
        expect(harness.reports).toHaveLength(2);
        const firstTurn = harness.effects.indexOf("runTurn");
        expect(harness.effects.lastIndexOf(REPORT)).toBeLessThan(firstTurn);
    });
});
