import { vi } from "vitest";
import { registerActivities } from "../../src/session-proxy.ts";

/**
 * The runTurn activity with a fake session manager, session and CMS catalog.
 * `turn(opts)` plays the Copilot turn: it can call `opts.onEvent` and returns
 * the ManagedSession turn result.
 *
 * Session turn control (runTurnV4) options: `catalogExtras`, `sessionExtras`
 * and `managerExtras` add or override fake methods; `sessionStore` with
 * `sessionStateDir` enables the lifecycle protocol; `workspaceProvider` serves
 * workspace attaches. `runTurn(sessionId, inputOverrides, handlerName)`
 * selects the input and the registered activity name.
 */
export function makeRunTurnHarness({
    turn,
    owner = null,
    featureFlagCache = null,
    catalogExtras = {},
    sessionExtras = {},
    managerExtras = {},
    sessionStore = null,
    sessionStateDir = null,
    workspaceProvider = null,
    cancelled = () => false,
} = {}) {
    const handlers = {};
    const runtime = { registerActivity(name, handler) { handlers[name] = handler; } };
    const session = {
        abort: vi.fn(),
        runTurn: vi.fn(async (_prompt, opts) => (turn
            ? await turn(opts)
            : { type: "completed", content: "ok", events: [] })),
        ...sessionExtras,
    };
    const sessionManager = {
        withRunTurnLock: vi.fn(async (_sessionId, _operation, fn) => await fn()),
        getOrCreate: vi.fn(async () => session),
        getModelSummary: vi.fn(() => undefined),
        getWorkspaceProvider: vi.fn(() => workspaceProvider),
        getFeatureFlagCache: vi.fn(() => featureFlagCache),
        invalidateWarmSession: vi.fn(async () => {}),
        resetSessionState: vi.fn(async () => {}),
        dehydrate: vi.fn(async () => {}),
        hydrate: vi.fn(async () => {}),
        needsHydration: vi.fn(async () => false),
        ...(sessionStateDir ? { getSessionStateDir: vi.fn(() => sessionStateDir), dropWarmSession: vi.fn(async () => {}) } : {}),
        ...managerExtras,
    };
    const recordedEvents = [];
    const catalog = {
        getSession: vi.fn(async (sessionId) => ({ sessionId, owner })),
        recordEvents: vi.fn(async (_sessionId, events) => { recordedEvents.push(...events); }),
        upsertSessionMetricSummary: vi.fn(async () => {}),
        updateSession: vi.fn(async () => {}),
        ...catalogExtras,
    };
    registerActivities(runtime, sessionManager, sessionStore, undefined, catalog,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "worker-1");

    const traces = { info: [], warn: [] };
    const activityCtx = {
        traceInfo: (message) => traces.info.push(message),
        traceWarn: (message) => traces.warn.push(message),
        isCancelled: () => cancelled(),
    };
    return {
        session,
        sessionManager,
        catalog,
        recordedEvents,
        traces,
        handlers,
        runTurn: (sessionId = "harness-session", inputOverrides = {}, handlerName = "runTurn") => handlers[handlerName](activityCtx, {
            sessionId, prompt: "go", config: {}, turnIndex: 0, ...inputOverrides,
        }),
    };
}
