import { describe, expect, it, vi } from "vitest";
import { isAbsolute } from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";

const getEnv = useSuiteEnv(import.meta.url);
const OLD = process.env.PS_REPLAY_84_ROOT;
const CURRENT = process.env.PS_REPLAY_RELEASE_C_ROOT;
const OWNER = { provider: "test", subject: "real-frozen-84-replay" };
const PARK = "REAL_FROZEN_84_PARK: wait, then read the harmless fact fixture.";
const PROBE = "REAL_RELEASE_C_LATEST_PROBE";
const DONE = "REAL_FROZEN_84_COMPLETED";
const WAIT_SECONDS = 60;
const CEILING = ["read_facts", "wait"];

async function moduleAt(root, path) {
    if (!root) throw new Error("Frozen replay requires both PS_REPLAY_84_ROOT and PS_REPLAY_RELEASE_C_ROOT.");
    return import(/* @vite-ignore */ `${root}/packages/sdk/${path}`);
}

async function sourceVersions() {
    if (!OLD || !CURRENT) {
        throw new Error("Requested frozen replay requires both PS_REPLAY_84_ROOT and PS_REPLAY_RELEASE_C_ROOT.");
    }
    expect(isAbsolute(OLD)).toBe(true);
    expect(isAbsolute(CURRENT)).toBe(true);
    expect(OLD).not.toBe(CURRENT);
    const old = (await moduleAt(OLD, "src/orchestration-version.ts")).DURABLE_SESSION_LATEST_VERSION;
    const current = (await moduleAt(CURRENT, "src/orchestration-version.ts")).DURABLE_SESSION_LATEST_VERSION;
    expect(old).toBe("1.0.84");
    expect(current).toMatch(/^1\.0\.\d+$/);
    expect(Number(current.split(".")[2])).toBeGreaterThanOrEqual(85);
    return { old, current };
}

function offeredTools(body) {
    return (body.tools ?? []).map(tool => tool.function.name).sort();
}

async function historyFor(dx, sessionId) {
    const instance = `session-${sessionId}`;
    const executions = await dx.listExecutions(instance);
    const events = (await Promise.all(executions.map(id => dx.readExecutionHistory(instance, id)))).flat();
    return { executions, events };
}

function scheduledActivities(events) {
    return events.filter(event => event.kind === "ActivityScheduled").map(event => {
        const name = /"name":"([^"]+)"/.exec(String(event.data))?.[1];
        expect(name).toBeDefined();
        return name;
    });
}

function customStatus(status) {
    return typeof status.customStatus === "string" ? JSON.parse(status.customStatus) : status.customStatus;
}

describe.skipIf(!OLD && !CURRENT)("real-source frozen 1.0.84 replay on Release C", () => {
    it("resumes an old worker's parked durable wait without replacing its execution or history", { timeout: 300_000 }, async () => {
        const env = getEnv();
        const versions = await sourceVersions();
        const offers = { parked: [], resumed: [] };
        const factResults = [];
        const model = await startScriptedModel({
            respond(body, position) {
                if (position.lastUserText.includes(PROBE)) return { content: "RELEASE_C_LATEST_READY" };
                if (position.lastUserText.includes("wait is now complete")) {
                    if (position.step === 0) {
                        offers.resumed.push(offeredTools(body));
                        return { tools: [{ name: "read_facts", args: {} }] };
                    }
                    factResults.push(position.toolResults);
                    return { content: DONE };
                }
                if (position.lastUserText.includes(PARK)) {
                    if (position.step === 0) {
                        offers.parked.push(offeredTools(body));
                        return { tools: [{ name: "wait", args: { seconds: WAIT_SECONDS, reason: PARK } }] };
                    }
                    return { content: "REAL_FROZEN_84_PARKED" };
                }
                throw new Error("Unexpected session request in the frozen replay fixture.");
            },
        });
        try {
            const oldHelpers = await moduleAt(OLD, "test/helpers/scripted-workers.js");
            const oldWorkers = await moduleAt(OLD, "test/helpers/local-workers.js");
            const currentWorkers = await moduleAt(CURRENT, "test/helpers/local-workers.js");
            const modelProvidersPath = await oldHelpers.registerScriptedProvider(env, model.baseUrl);
            const options = {
                worker: { modelProvidersPath, logLevel: "warning" },
                client: { modelProvidersPath, dehydrateOnIdle: 1800 },
            };
            let sessionId;
            let originalConfig;
            let originalHistory;
            await oldWorkers.withClient(env, { ...options, workerNodeId: "frozen-replay-old" }, async client => {
                const session = await client.createSession({
                    owner: OWNER, model: oldHelpers.FIXTURE_QUALIFIED_MODEL, waitThreshold: 1, toolCeiling: CEILING,
                });
                sessionId = session.sessionId;
                const dx = client._getDuroxideClient();
                await session.send(PARK);
                await vi.waitFor(async () => {
                    const waits = await client._catalog.getSessionEvents(sessionId, undefined, 10, ["session.wait_started"]);
                    // The worker emits the same event type before the orchestration admits its timer.
                    const admitted = waits.filter(event => typeof event.data.preserveAffinity === "boolean");
                    expect(admitted).toHaveLength(1);
                    expect(admitted[0].data).toMatchObject({ seconds: WAIT_SECONDS, reason: PARK });
                    expect(customStatus(await dx.getStatus(`session-${sessionId}`)).status).toBe("waiting");
                }, { timeout: 60_000 });
                expect((await dx.getInstanceInfo(`session-${sessionId}`)).orchestrationVersion).toBe("1.0.84");
                expect(offers.parked.length).toBeGreaterThan(0);
                for (const offer of offers.parked) expect(offer).toEqual(CEILING);
                originalConfig = await client._catalog.getSessionCreationConfig(sessionId);
                originalHistory = await historyFor(dx, sessionId);
                expect(originalHistory.executions).toEqual([1]);
                expect(scheduledActivities(originalHistory.events)).toContain("runTurnV6");
            });
            // withClient has stopped both the old client and worker before any replacement starts.
            expect(offers.resumed).toHaveLength(0);
            const management = await currentWorkers.createManagementClient(env);
            try {
                expect((await management.getSessionStatus(sessionId)).customStatus.status).toBe("waiting");
                expect(await management._catalog.getSessionEvents(sessionId, undefined, 10, ["session.wait_completed"]))
                    .toHaveLength(0);
                await currentWorkers.withClient(env, { ...options, workerNodeId: "frozen-replay-current" }, async client => {
                    const dx = client._getDuroxideClient();
                    const probe = await client.createSession({
                        owner: OWNER, model: oldHelpers.FIXTURE_QUALIFIED_MODEL, toolCeiling: ["read_facts"],
                    });
                    expect(await probe.sendAndWait(PROBE, 60_000)).toBe("RELEASE_C_LATEST_READY");
                    expect((await dx.getInstanceInfo(`session-${probe.sessionId}`)).orchestrationVersion).toBe(versions.current);
                    await vi.waitFor(async () => {
                        expect(await management.getLatestResponse(sessionId)).toMatchObject({ type: "completed", content: DONE });
                    }, { timeout: 120_000 });
                    expect(offers.resumed.length).toBeGreaterThan(0);
                    for (const offer of offers.resumed) expect(offer).toEqual(CEILING);
                    expect(factResults.length).toBeGreaterThan(0);
                    for (const results of factResults) {
                        expect(results).toHaveLength(1);
                        expect(JSON.parse(results[0])).toMatchObject({ count: 0, facts: [] });
                    }
                    const history = await historyFor(dx, sessionId);
                    expect(history.executions).toEqual(originalHistory.executions);
                    expect(history.events.length).toBeGreaterThan(originalHistory.events.length);
                    expect(history.events.slice(0, originalHistory.events.length)).toEqual(originalHistory.events);
                    const activities = scheduledActivities(history.events);
                    expect(activities.filter(name => name === "runTurnV6").length).toBeGreaterThanOrEqual(2);
                    expect((await dx.getInstanceInfo(`session-${sessionId}`)).orchestrationVersion).toBe("1.0.84");
                    expect(await client._catalog.getSessionCreationConfig(sessionId)).toEqual(originalConfig);
                    const waits = await client._catalog.getSessionEvents(sessionId, undefined, 10, ["session.wait_completed"]);
                    expect(waits).toHaveLength(1);
                    expect(waits[0].data).toMatchObject({ seconds: WAIT_SECONDS });
                    console.info("REAL_FROZEN_84_REPLAY", JSON.stringify({
                        oldRoot: OLD, currentRoot: CURRENT, versions, executions: history.executions,
                        preservedHistoryEvents: originalHistory.events.length, historyEvents: history.events.length,
                        activities, offers, waitSeconds: WAIT_SECONDS, response: DONE,
                    }));
                });
            } finally {
                await management.stop();
            }
        } finally {
            await model.close();
        }
    });
});
