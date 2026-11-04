/**
 * Workflow v2: whose status a workflow session's row shows (review B1 of fix B, f2b8fe97). A workflow's terminal row is
 * its status in a detail read (session-status.ts), so the row must belong to the run the reader means: once the workflow
 * has a live run, the row follows it. Against PostgreSQL, with the store called as the controller's activities call it
 * (begin and finish with their session projections); the detail is PilotSwarmClient._getSessionInfo over the real
 * catalog with the controller stood in as Running.
 *
 * - A draft with only test runs shows its latest test, as before.
 * - A live admission resets the row to pending, without the test's error; a repeated start (its receipt replayed) does
 *   not reset the row of a live run that has ended.
 * - A test run that begins or ends after the live run was admitted records its events and leaves the row alone.
 * - The live run's own end is the detail's answer while its controller still runs (the F-C2 window).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { PilotSwarmClient } from "../../src/client.ts";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowLiveControllerInstanceId, workflowTestControllerInstanceId } from "../../src/workflow/v2/runtime.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;

const YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: session-row, version: "1.0.0" }
initial: step
states:
  step:
    type: script
    source: |
      await setResult("ok", { n: 3 });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
`;
const TEST_ERROR = canonicalJson({ code: "script_failed", message: "The test's script failed." });
const LIVE_ERROR = canonicalJson({ code: "timed_out", message: "State 'step' ended with runtime error 'timed_out' and has no route for it." });

/** The session projections the controller's begin and finish activities send (runtime.ts). */
const begun = (workflowSessionId, runId, mode) => ({
    sessionId: workflowSessionId, events: [{ eventType: "workflow.started", data: { runId, mode } }],
    update: { state: "running", lastError: null, touch: true },
});
const ended = (workflowSessionId, runId, status, errorText) => ({
    sessionId: workflowSessionId,
    events: [{ eventType: status === "failed" ? "workflow.failed" : "workflow.completed", data: { runId, ...(errorText ? { error: errorText } : {}) } }],
    update: { state: status, lastError: status === "failed" ? errorText : null, touch: true },
});

async function fixture(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const compiled = compileWorkflowV2(YAML);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const liveStart = (workflowSessionId, runId) => ({ runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
        inputsText: "{}", kvText: "{}", testAgentMode: null });
    return {
        catalog, store, compiled, liveStart,
        /** A new workflow child of a new parent: a draft, or published with its live run admitted (`live`). */
        async workflow(label, { live = null } = {}) {
            const owner = { provider: "test", subject: `${label}-${randomUUID()}` };
            const parent = randomUUID();
            await catalog.createSession(parent, { owner });
            const workflowSessionId = randomUUID();
            expect((await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner,
                creationConfig: { workflowV2: { requestSha256: label } } })).created).toBe(true);
            const create = {
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: YAML, compiled, actor: { kind: "system", name: `${label}-test` },
                operationId: "create", requestSha256: label, publish: live !== null, title: `Workflow: ${label}`,
                start: live === null ? null : liveStart(workflowSessionId, live),
            };
            await store.createDefinition(create);
            return { workflowSessionId, create };
        },
        /** Admit a test run of the draft (of-06: only a draft is tested). */
        async test(workflowSessionId, runId, operationId) {
            await store.startTest({
                workflowSessionId, expectedRevision: 1, definitionHash: compiled.yamlSha256, operationId, requestSha256: operationId,
                start: { runId, mode: "test", controllerInstanceId: workflowTestControllerInstanceId(runId), inputsText: "{}", kvText: "{}",
                    testAgentMode: "mocked", controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION },
            });
        },
        /** Publish the draft and admit its first live run in one request. */
        publishAndStart(workflowSessionId, runId, operationId = "publish") {
            return store.publish({ workflowSessionId, expectedRevision: 1, definitionHash: compiled.yamlSha256, operationId, requestSha256: operationId,
                start: liveStart(workflowSessionId, runId) });
        },
        begin: (workflowSessionId, runId, mode) => store.beginRun(runId, begun(workflowSessionId, runId, mode)),
        finish: (workflowSessionId, runId, status, errorText = null) => store.finishRun({
            runId, status, terminalNodeId: null, terminalOutcome: null, outputText: null, errorText,
            endPending: { winner: "controller", message: "The workflow run ended before this state finished." },
            projection: ended(workflowSessionId, runId, status, errorText),
        }),
        /** The row, the session list's entry and a detail read while the workflow's controller still runs. */
        async seen(workflowSessionId) {
            const row = await catalog.getSession(workflowSessionId);
            const listed = (await catalog.listSessions()).find(item => item.sessionId === workflowSessionId);
            const updates = [];
            const sdk = {
                _catalog: { getSession: id => catalog.getSession(id), updateSession: async (id, patch) => { updates.push([id, patch]); } },
                duroxideClient: { getStatus: async () => ({ status: "Running", customStatus: JSON.stringify({ status: "running" }) }) },
                _getLatestResponse: async () => null,
            };
            const detail = await PilotSwarmClient.prototype._getSessionInfo.call(sdk, workflowSessionId);
            expect(updates, "a detail read never writes a workflow's row").toEqual([]);
            return { state: row.state, lastError: row.lastError ?? null, listed: listed?.state, detail: detail.status, detailError: detail.error ?? null };
        },
        eventsOf: async (workflowSessionId, type, runId) => (await catalog.getSessionEvents(workflowSessionId, 0, 500, [type]))
            .filter(event => event.data?.runId === runId),
        close: () => catalog.close(),
    };
}

describe("workflow v2: a workflow session's row follows its live run (review B1)", () => {
    it("a draft with only test runs shows its latest test, as before", { timeout: TIMEOUT }, async () => {
        const h = await fixture(getEnv());
        try {
            const { workflowSessionId } = await h.workflow("draft-only");
            const first = randomUUID();
            await h.test(workflowSessionId, first, "test-1");
            await h.begin(workflowSessionId, first, "test");
            expect(await h.seen(workflowSessionId)).toMatchObject({ state: "running", listed: "running", detail: "running" });
            await h.finish(workflowSessionId, first, "failed", TEST_ERROR);
            expect(await h.seen(workflowSessionId)).toEqual({ state: "failed", lastError: TEST_ERROR, listed: "failed", detail: "failed", detailError: TEST_ERROR });
            const second = randomUUID();
            await h.test(workflowSessionId, second, "test-2");
            await h.begin(workflowSessionId, second, "test");
            await h.finish(workflowSessionId, second, "completed");
            expect(await h.seen(workflowSessionId)).toEqual({ state: "completed", lastError: null, listed: "completed", detail: "completed", detailError: null });
        } finally {
            await h.close();
        }
    });

    it("a test's end, then the first live admission with its begin held back: no old terminal status or error in the detail or the list", { timeout: TIMEOUT }, async () => {
        const h = await fixture(getEnv());
        try {
            const { workflowSessionId } = await h.workflow("after-test");
            const test = randomUUID();
            await h.test(workflowSessionId, test, "test-1");
            await h.begin(workflowSessionId, test, "test");
            await h.finish(workflowSessionId, test, "failed", TEST_ERROR);
            expect(await h.seen(workflowSessionId)).toMatchObject({ state: "failed", detail: "failed", detailError: TEST_ERROR });

            // The live run is admitted; its controller runs but has not begun the run.
            const live = randomUUID();
            await h.publishAndStart(workflowSessionId, live);
            expect((await h.store.readRun(live)).status).toBe("admitted");
            const before = await h.seen(workflowSessionId);
            expect(before).toEqual({ state: "pending", lastError: null, listed: "pending", detail: "running", detailError: null });
            expect((await h.catalog.getSession(workflowSessionId)).orchestrationId).toBe(workflowLiveControllerInstanceId(workflowSessionId));
            // Begun: running.
            await h.begin(workflowSessionId, live, "live");
            expect(await h.seen(workflowSessionId)).toEqual({ state: "running", lastError: null, listed: "running", detail: "running", detailError: null });
        } finally {
            await h.close();
        }
    });

    it("a test that begins or ends after the live run was admitted records its events and leaves the live row nonterminal", { timeout: TIMEOUT }, async () => {
        const h = await fixture(getEnv());
        try {
            const { workflowSessionId } = await h.workflow("late-test");
            // Two tests admitted while the definition was a draft: one begun, one not yet.
            const begunTest = randomUUID();
            const lateTest = randomUUID();
            await h.test(workflowSessionId, begunTest, "test-1");
            await h.test(workflowSessionId, lateTest, "test-2");
            await h.begin(workflowSessionId, begunTest, "test");
            const live = randomUUID();
            await h.publishAndStart(workflowSessionId, live);
            // The other test begins only now, before the live run's begin: the row stays the live run's (pending).
            await h.begin(workflowSessionId, lateTest, "test");
            expect(await h.seen(workflowSessionId)).toMatchObject({ state: "pending", lastError: null, listed: "pending" });
            await h.begin(workflowSessionId, live, "live");

            // Both tests end while the live run runs: their ends are recorded, the row is still the live run's.
            expect((await h.finish(workflowSessionId, begunTest, "failed", TEST_ERROR)).ended).toBe(true);
            expect((await h.finish(workflowSessionId, lateTest, "completed")).ended).toBe(true);
            expect(await h.seen(workflowSessionId)).toEqual({ state: "running", lastError: null, listed: "running", detail: "running", detailError: null });
            expect(await h.eventsOf(workflowSessionId, "workflow.failed", begunTest)).toHaveLength(1);
            expect(await h.eventsOf(workflowSessionId, "workflow.completed", lateTest)).toHaveLength(1);
            expect((await h.store.readRun(begunTest)).status).toBe("failed");
            expect((await h.store.readRun(live)).status).toBe("running");

            // The live run's own end is the row's.
            await h.finish(workflowSessionId, live, "completed");
            expect(await h.seen(workflowSessionId)).toEqual({ state: "completed", lastError: null, listed: "completed", detail: "completed", detailError: null });
        } finally {
            await h.close();
        }
    });

    it("the live run's own end is the detail's answer while its controller still runs, with its error", { timeout: TIMEOUT }, async () => {
        const h = await fixture(getEnv());
        try {
            const live = randomUUID();
            const { workflowSessionId } = await h.workflow("same-run", { live });
            await h.begin(workflowSessionId, live, "live");
            await h.finish(workflowSessionId, live, "failed", LIVE_ERROR);
            expect(await h.seen(workflowSessionId)).toEqual({ state: "failed", lastError: LIVE_ERROR, listed: "failed", detail: "failed", detailError: LIVE_ERROR });
        } finally {
            await h.close();
        }
    });

    it("a repeated start (its receipt replayed) does not change the row of a live run that has ended; another start is refused", { timeout: TIMEOUT }, async () => {
        const h = await fixture(getEnv());
        try {
            // Created, published and started in one request.
            const live = randomUUID();
            const { workflowSessionId, create } = await h.workflow("repeat-create", { live });
            await h.begin(workflowSessionId, live, "live");
            await h.finish(workflowSessionId, live, "failed", LIVE_ERROR);
            const endedRow = await h.seen(workflowSessionId);
            expect(endedRow).toMatchObject({ state: "failed", lastError: LIVE_ERROR });
            expect(await h.store.createDefinition(create)).toMatchObject({ replayed: true, receipt: { run: { runId: live } } });
            expect(await h.seen(workflowSessionId)).toEqual(endedRow);

            // Published and started after a test.
            const { workflowSessionId: tested } = await h.workflow("repeat-publish");
            const test = randomUUID();
            await h.test(tested, test, "test-1");
            await h.finish(tested, test, "completed");
            const first = randomUUID();
            await h.publishAndStart(tested, first);
            await h.begin(tested, first, "live");
            await h.finish(tested, first, "failed", LIVE_ERROR);
            const publishedRow = await h.seen(tested);
            expect(publishedRow).toMatchObject({ state: "failed", lastError: LIVE_ERROR });
            expect(await h.publishAndStart(tested, first)).toMatchObject({ replayed: true, receipt: { run: { runId: first } } });
            expect(await h.seen(tested)).toEqual(publishedRow);
            // A new start is refused before it changes anything.
            await expect(h.store.startLive({ workflowSessionId: tested, definitionHash: h.compiled.yamlSha256, operationId: "start-2",
                requestSha256: "start-2", start: h.liveStart(tested, randomUUID()) })).rejects.toMatchObject({ code: "LIVE_RUN_EXISTS" });
            expect(await h.seen(tested)).toEqual(publishedRow);
        } finally {
            await h.close();
        }
    });
});
