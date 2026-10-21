/**
 * Cron prechecks end to end: a real worker, PostgreSQL, Duroxide durable cron
 * timers and the Copilot CLI, with the model replaced by scripted-model.mjs so
 * every model request is counted.
 *
 *  1. The prompt opts in: the agent calls cron(..., precheck="queue"). Empty
 *     cycles are skipped with no model request; the first cycle the precheck
 *     reports work runs the model.
 *  2. The session opts in by default (createSession({ cronPrecheck })) and the
 *     registration is shadow: the skip is recorded and the model still runs.
 *
 * Run: npx vitest run test/local/cron-precheck-live.test.js
 */
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { scriptTurns } from "../helpers/scripted-model.mjs";
import { withScriptedModel } from "../helpers/scripted-workers.js";

const TIMEOUT = 240_000;
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

const script = (cronArgs) => scriptTurns([
    [{ tools: [{ name: "cron", args: { seconds: 15, reason: REASON, ...cronArgs } }] }, { content: "armed" }],
    [{ content: "cycle ran" }],
]);

async function startPollingSession(env, client, sessionConfig) {
    const session = await client.createSession(sessionConfig);
    const catalog = await createCatalog(env);
    try {
        // The kickoff turn arms cron, so the session waits on the schedule
        // rather than going idle: wait for the armed schedule itself.
        await session.send(KICKOFF);
        const [started] = await waitForEventCount(catalog, session.sessionId, "session.cron_started", 1, 60_000);
        return { session, started };
    } finally {
        await catalog.close?.();
    }
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
    it("a cron call that names a precheck calls no model until it reports work", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await withScriptedModel(env, { respond: script({ precheck: "queue" }) }, async ({ client, worker, model, qualifiedModel }) => {
            let hasWork = false;
            const seen = [];
            worker.registerCronPrechecks([{
                name: "queue",
                check: ({ consecutiveSkips }) => {
                    seen.push(consecutiveSkips);
                    return hasWork ? { action: "run", detail: "one job" } : { action: "skip", detail: "queue empty" };
                },
            }]);
            const { session, started } = await startPollingSession(env, client, { model: qualifiedModel });
            expect(started.data).toMatchObject({ reason: REASON, precheck: "queue" });
            const armedRequests = model.sessionRequests(KICKOFF).length;

            await waitFor(() => seen.length >= 2, 75_000, "two skipped cycles");
            expect(model.sessionRequests(KICKOFF).length).toBe(armedRequests);
            expect(seen.slice(0, 2)).toEqual([0, 1]);

            hasWork = true;
            await waitFor(() => model.sessionRequests(KICKOFF).length > armedRequests, 45_000, "the model to run a cycle");
            expect(model.sessionRequests(KICKOFF).at(-1).position.turn).toBe(2);

            const events = await precheckEvents(env, session.sessionId);
            expect(events.slice(0, 2).map((e) => [e.precheck, e.outcome, e.skipped])).toEqual([
                ["queue", "skip", true],
                ["queue", "skip", true],
            ]);
            expect(events.some((e) => e.outcome === "run" && e.skipped === false)).toBe(true);
        });
    });

    it("a session default applies to a plain cron call, and a shadow precheck still runs the model", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await withScriptedModel(env, { respond: script({}) }, async ({ client, worker, model, qualifiedModel }) => {
            worker.registerCronPrechecks([{
                name: "queue",
                shadow: true,
                check: () => ({ action: "skip", detail: "queue empty" }),
            }]);
            const { session, started } = await startPollingSession(env, client, { model: qualifiedModel, cronPrecheck: "queue" });
            expect(started.data).toMatchObject({ reason: REASON, precheck: "queue" });
            const armedRequests = model.sessionRequests(KICKOFF).length;

            await waitFor(() => model.sessionRequests(KICKOFF).length > armedRequests, 45_000, "the model to run a cycle");
            const events = await precheckEvents(env, session.sessionId);
            expect(events[0]).toMatchObject({ precheck: "queue", outcome: "skip", skipped: false, shadow: true, detail: "queue empty" });
        });
    });
});
