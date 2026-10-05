import { vi } from "vitest";
import { registerActivities } from "../../src/session-proxy.ts";

/**
 * The runTurn activity with a fake session manager, session and CMS catalog.
 * `turn(opts)` plays the Copilot turn: it can call `opts.onEvent` and returns
 * the ManagedSession turn result.
 */
export function makeRunTurnHarness({ turn, owner = null, featureFlagCache = null } = {}) {
    const handlers = {};
    const runtime = { registerActivity(name, handler) { handlers[name] = handler; } };
    const session = {
        abort: vi.fn(),
        runTurn: vi.fn(async (_prompt, opts) => (turn
            ? await turn(opts)
            : { type: "completed", content: "ok", events: [] })),
    };
    const sessionManager = {
        withRunTurnLock: vi.fn(async (_sessionId, _operation, fn) => await fn()),
        getOrCreate: vi.fn(async () => session),
        getModelSummary: vi.fn(() => undefined),
        getWorkspaceProvider: vi.fn(() => null),
        getFeatureFlagCache: vi.fn(() => featureFlagCache),
        invalidateWarmSession: vi.fn(async () => {}),
        resetSessionState: vi.fn(async () => {}),
        dehydrate: vi.fn(async () => {}),
        hydrate: vi.fn(async () => {}),
        needsHydration: vi.fn(async () => false),
    };
    const recordedEvents = [];
    const catalog = {
        getSession: vi.fn(async (sessionId) => ({ sessionId, owner })),
        acknowledgeWorkflowRunSession: vi.fn(async () => {}),
        recordEvents: vi.fn(async (_sessionId, events) => { recordedEvents.push(...events); }),
        upsertSessionMetricSummary: vi.fn(async () => {}),
        updateSession: vi.fn(async () => {}),
    };
    registerActivities(runtime, sessionManager, null, undefined, catalog,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "worker-1");

    const traces = { info: [], warn: [] };
    const activityCtx = {
        traceInfo: (message) => traces.info.push(message),
        traceWarn: (message) => traces.warn.push(message),
        isCancelled: () => false,
    };
    return {
        session,
        sessionManager,
        catalog,
        recordedEvents,
        traces,
        runTurn: (sessionId = "harness-session") => handlers.runTurn(activityCtx, {
            sessionId, prompt: "go", config: {}, turnIndex: 0,
        }),
    };
}
