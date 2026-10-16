/**
 * Cron prechecks end to end: a real worker, PostgreSQL, Duroxide durable cron
 * timers and the Copilot CLI, with the model replaced by scripted-model.mjs so
 * every model request is counted.
 *
 *  1. Enforced (flag on): empty cycles are skipped with no model request; the
 *     first cycle the precheck reports work runs the model.
 *  2. Shadow (flag off): the precheck's skip is recorded, and the model still
 *     runs the cycle.
 *
 * Run: npx vitest run test/local/cron-precheck-live.test.js
 */
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { scriptTurns } from "../helpers/scripted-model.mjs";
import { setClusterFeature, withScriptedModel } from "../helpers/scripted-workers.js";
import { CRON_PRECHECK_SKIP_FEATURE } from "../../src/cron-precheck.ts";

const TIMEOUT = 240_000;
const AGENT = "work-poller";
const REASON = "check the work queue";
const KICKOFF = "start polling the work queue";
const getEnv = useSuiteEnv(import.meta.url);

async function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${label}`);
}

const script = () => scriptTurns([
    [{ tools: [{ name: "cron", args: { seconds: 15, reason: REASON } }] }, { content: "armed" }],
    [{ content: "cycle ran" }],
]);

async function startPollingSession(env, client, qualifiedModel) {
    const session = await client.createSession({ model: qualifiedModel });
    const catalog = await createCatalog(env);
    try {
        await catalog.updateSession(session.sessionId, { agentId: AGENT });
        // The kickoff turn arms cron, so the session waits on the schedule
        // rather than going idle: wait for the armed schedule itself.
        await session.send(KICKOFF);
        await waitForEventCount(catalog, session.sessionId, "session.cron_started", 1, 60_000);
    } finally {
        await catalog.close?.();
    }
    return session;
}

async function precheckEvents(env, sessionId) {
    const catalog = await createCatalog(env);
    try {
        const events = await catalog.getSessionEvents(sessionId, undefined, 500, ["session.cron_precheck"]);
        return events.map((event) => event.data);
    } finally {
        await catalog.close?.();
    }
}

describe("cron precheck (live)", () => {
    it("an enforced skip calls no model until the precheck reports work", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await setClusterFeature(env, CRON_PRECHECK_SKIP_FEATURE, true, { allowUserOverride: false });
        await withScriptedModel(env, { respond: script() }, async ({ client, worker, model, qualifiedModel }) => {
            let hasWork = false;
            const seen = [];
            worker.registerCronPrechecks([{
                name: "queue",
                agents: [AGENT],
                reasons: [REASON],
                check: ({ consecutiveSkips }) => {
                    seen.push(consecutiveSkips);
                    return hasWork ? { action: "run", detail: "one job" } : { action: "skip", detail: "queue empty" };
                },
            }]);
            const session = await startPollingSession(env, client, qualifiedModel);
            const armedRequests = model.sessionRequests(KICKOFF).length;

            await waitFor(() => seen.length >= 2, 75_000, "two skipped cycles");
            expect(model.sessionRequests(KICKOFF).length).toBe(armedRequests);
            expect(seen.slice(0, 2)).toEqual([0, 1]);

            hasWork = true;
            await waitFor(() => model.sessionRequests(KICKOFF).length > armedRequests, 45_000, "the model to run a cycle");
            const cycle = model.sessionRequests(KICKOFF).at(-1);
            expect(cycle.position.turn).toBe(2);

            const events = await precheckEvents(env, session.sessionId);
            expect(events.slice(0, 2).map((e) => [e.outcome, e.skipped, e.enforced])).toEqual([
                ["skip", true, true],
                ["skip", true, true],
            ]);
            expect(events.some((e) => e.outcome === "run" && e.skipped === false)).toBe(true);
        });
    });

    it("shadow mode records the skip and still runs the model", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await setClusterFeature(env, CRON_PRECHECK_SKIP_FEATURE, false, { allowUserOverride: false });
        await withScriptedModel(env, { respond: script() }, async ({ client, worker, model, qualifiedModel }) => {
            worker.registerCronPrechecks([{
                name: "queue",
                agents: [AGENT],
                check: () => ({ action: "skip", detail: "queue empty" }),
            }]);
            const session = await startPollingSession(env, client, qualifiedModel);
            const armedRequests = model.sessionRequests(KICKOFF).length;

            await waitFor(() => model.sessionRequests(KICKOFF).length > armedRequests, 45_000, "the model to run a cycle");
            const events = await precheckEvents(env, session.sessionId);
            expect(events[0]).toMatchObject({ precheck: "queue", outcome: "skip", skipped: false, enforced: false, detail: "queue empty" });
        });
    });
});
