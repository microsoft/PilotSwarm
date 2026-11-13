import { describe, expect, it, vi } from "vitest";
import { isAbsolute } from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "real-session-upgrade" };
const CHILD = "REAL_UPGRADE_CHILD: report the harmless fact fixture.";
const SPAWN = "REAL_UPGRADE_SPAWN";
const CEILING_SPAWN = "REAL_CEILING_SPAWN";
const OLD_83 = process.env.PS_UPGRADE_83_ROOT;
const PRODUCTION = process.env.PS_UPGRADE_PRODUCTION_ROOT;
const CURRENT = process.env.PS_UPGRADE_CURRENT_ROOT;

async function moduleAt(root, path) {
    if (!root) throw new Error("Real-source session upgrade requires the production, 1.0.83 and current source roots.");
    return import(/* @vite-ignore */ `${root}/packages/sdk/${path}`);
}

async function assertSourceVersions(oldRoot) {
    expect(isAbsolute(oldRoot ?? "")).toBe(true);
    expect(isAbsolute(CURRENT ?? "")).toBe(true);
    expect(oldRoot).not.toBe(CURRENT);
    expect((await moduleAt(oldRoot, "src/orchestration-version.ts")).DURABLE_SESSION_LATEST_VERSION).toBe("1.0.83");
    expect((await moduleAt(CURRENT, "src/orchestration-version.ts")).DURABLE_SESSION_LATEST_VERSION).toBe("1.0.84");
}

async function scheduledActivities(client, sessionId) {
    const dx = client._getDuroxideClient();
    const instance = `session-${sessionId}`;
    const history = (await Promise.all((await dx.listExecutions(instance))
        .map(id => dx.readExecutionHistory(instance, id)))).flat();
    return history.filter(event => event.kind === "ActivityScheduled").map(event => {
        // Native history can omit undefined input bytes; the activity name remains intact.
        const name = /"name":"([^"]+)"/.exec(String(event.data))?.[1];
        expect(name).toBeDefined();
        return name;
    });
}

function responder(offers, factResults) {
    return (body, position) => {
        if (position.firstUserText.includes(CHILD)) {
            if (position.step === 0) {
                offers.push((body.tools ?? []).map(tool => tool.function.name).sort());
                return { tools: [{ name: "read_facts", args: {} }] };
            }
            factResults.push(position.toolResults);
            return { content: "CHILD_FACTS_READ" };
        }
        if (position.lastUserText.includes(CEILING_SPAWN) && position.step === 0) {
            return { tools: [{ name: "spawn_agent", args: { task: CHILD, tools: ["read_facts"] } }] };
        }
        if (position.lastUserText.includes(SPAWN) && position.step === 0) {
            return { tools: [{ name: "spawn_agent", args: { task: CHILD, tool_names: ["read_facts"] } }] };
        }
        return { content: "ok" };
    };
}

async function assertChildFactResult(env, childId, factResults, index) {
    await vi.waitFor(() => expect(factResults.length).toBeGreaterThan(index), { timeout: 60_000 });
    expect(factResults[index]).toHaveLength(1);
    expect(JSON.parse(factResults[index][0])).toMatchObject({ count: 0, facts: [] });
    const management = await (await moduleAt(CURRENT, "test/helpers/local-workers.js")).createManagementClient(env);
    try {
        await vi.waitFor(async () => expect((await management.getLatestResponse(childId))?.content)
            .toBe("CHILD_FACTS_READ"), { timeout: 60_000 });
    } finally {
        await management.stop();
    }
}

async function spawnProbe(root, env, offers, factResults, providerPath) {
    const helpers = await moduleAt(root, "test/helpers/scripted-workers.js");
    const workers = await moduleAt(root, "test/helpers/local-workers.js");
    let result;
    await workers.withClient(env, { worker: { modelProvidersPath: providerPath, logLevel: "warning" },
        client: { modelProvidersPath: providerPath } }, async (client) => {
        const parent = await client.createSession({ owner: OWNER, model: helpers.FIXTURE_QUALIFIED_MODEL });
        const before = offers.length;
        expect(await parent.sendAndWait(SPAWN, 60_000)).toBe("ok");
        await vi.waitFor(() => expect(offers.length).toBeGreaterThan(before), { timeout: 60_000 });
        const child = (await client._catalog.listSessions()).find(row => row.parentSessionId === parent.sessionId);
        expect(child).toBeDefined();
        await vi.waitFor(async () => expect((await client._catalog.getSession(child.sessionId)).state)
            .toBe("idle"), { timeout: 30_000 });
        result = {
            tools: offers[before],
            config: await client._catalog.getSessionCreationConfig(child.sessionId),
            version: (await client._getDuroxideClient().getInstanceInfo(`session-${child.sessionId}`)).orchestrationVersion,
            activities: await scheduledActivities(client, child.sessionId),
        };
        expect(result.config.toolNames).toEqual(["read_facts"]);
        expect(result.tools).toContain("read_facts");
        await assertChildFactResult(env, child.sessionId, factResults, before);
        result.factResult = JSON.parse(factResults[before][0]);
    });
    return result;
}

describe.skipIf(!OLD_83 && !PRODUCTION && !CURRENT)("real-source session upgrade and ordinary spawn parity", () => {
    it("continues an actual 1.0.83 session as new into 1.0.84 and dispatches composition turns", { timeout: 300_000 }, async () => {
        const env = getEnv();
        await assertSourceVersions(OLD_83);
        const offers = [];
        const factResults = [];
        const model = await startScriptedModel({ respond: responder(offers, factResults) });
        let parentId;
        let providerPath;
        let oldChildId;
        let oldChildConfig;
        let oldHistory;
        try {
            const oldHelpers = await moduleAt(OLD_83, "test/helpers/scripted-workers.js");
            const oldWorkers = await moduleAt(OLD_83, "test/helpers/local-workers.js");
            providerPath = await oldHelpers.registerScriptedProvider(env, model.baseUrl);
            await oldWorkers.withClient(env, { worker: { modelProvidersPath: providerPath, logLevel: "warning" },
                client: { modelProvidersPath: providerPath } }, async client => {
                const parent = await client.createSession({ owner: OWNER, model: oldHelpers.FIXTURE_QUALIFIED_MODEL });
                parentId = parent.sessionId;
                expect(await parent.sendAndWait("Create an actual 1.0.83 conversation.", 60_000)).toBe("ok");
                expect((await client._getDuroxideClient().getInstanceInfo(`session-${parentId}`)).orchestrationVersion)
                    .toBe("1.0.83");
                expect(await scheduledActivities(client, parentId)).toContain("runTurnV5");
                expect(await parent.sendAndWait(SPAWN, 60_000)).toBe("ok");
                await vi.waitFor(() => expect(offers).toHaveLength(1), { timeout: 60_000 });
                oldChildId = (await client._catalog.listSessions()).find(row => row.parentSessionId === parentId)?.sessionId;
                expect(oldChildId).toBeDefined();
                await assertChildFactResult(env, oldChildId, factResults, 0);
                oldChildConfig = await client._catalog.getSessionCreationConfig(oldChildId);
                expect(oldChildConfig.toolNames).toEqual(["read_facts"]);
                expect(oldChildConfig.toolGrant).toBeUndefined();
                oldHistory = await client._getDuroxideClient().readExecutionHistory(`session-${parentId}`, 1);
                expect(oldHistory.some(event => event.kind === "ActivityCompleted")).toBe(true);
            });
            const currentWorkers = await moduleAt(CURRENT, "test/helpers/local-workers.js");
            await currentWorkers.withClient(env, { worker: { modelProvidersPath: providerPath, logLevel: "warning" },
                client: { modelProvidersPath: providerPath } }, async client => {
                const dx = client._getDuroxideClient();
                expect((await dx.getInstanceInfo(`session-${parentId}`)).orchestrationVersion).toBe("1.0.83");
                const management = await currentWorkers.createManagementClient(env);
                try {
                    // The public model command takes the real frozen handler's continue-as-new path.
                    await management.sendCommand(parentId, { cmd: "set_model", id: "force-real-upgrade",
                        args: { model: (await client._catalog.getSession(parentId)).model } });
                    await vi.waitFor(async () => expect((await dx.getInstanceInfo(`session-${parentId}`)).orchestrationVersion)
                        .toBe("1.0.84"), { timeout: 60_000 });
                    await vi.waitFor(async () => expect((await client._catalog.getSession(parentId)).state)
                        .toBe("idle"), { timeout: 60_000 });
                    const replayed = await dx.readExecutionHistory(`session-${parentId}`, 1);
                    expect(replayed.slice(0, oldHistory.length)).toEqual(oldHistory);
                    expect(await client._catalog.getSessionCreationConfig(oldChildId)).toEqual(oldChildConfig);
                    const parent = await client.resumeSession(parentId);
                    expect(await parent.sendAndWait(SPAWN, 60_000)).toBe("ok");
                    await vi.waitFor(() => expect(offers).toHaveLength(2), { timeout: 60_000 });
                    const parityChild = (await client._catalog.listSessions()).find(row =>
                        row.parentSessionId === parentId && row.sessionId !== oldChildId);
                    expect(parityChild).toBeDefined();
                    await assertChildFactResult(env, parityChild.sessionId, factResults, 1);
                    expect(offers[1]).toEqual(offers[0]);
                    expect((await client._catalog.getSessionCreationConfig(parityChild.sessionId)).toolGrant).toBeUndefined();
                    expect(await parent.sendAndWait(CEILING_SPAWN, 60_000)).toBe("ok");
                    await vi.waitFor(() => expect(offers).toHaveLength(3), { timeout: 60_000 });
                    const child = (await client._catalog.listSessions()).find(row =>
                        row.parentSessionId === parentId && row.sessionId !== oldChildId && row.sessionId !== parityChild.sessionId);
                    expect(child).toBeDefined();
                    await assertChildFactResult(env, child.sessionId, factResults, 2);
                    const childConfig = await client._catalog.getSessionCreationConfig(child.sessionId);
                    expect(childConfig.toolCeiling).toEqual(["read_facts"]);
                    const childActivities = await scheduledActivities(client, child.sessionId);
                    expect(childActivities).toContain("runTurnV6");
                    // Test-owned durable receipt of the actual CLI request; production telemetry stores only counts.
                    await client._catalog.recordEvents(child.sessionId, [{
                        eventType: "test.model_tool_offer", data: {
                            source: "actual-copilot-cli-request", toolNames: offers[2], toolCeiling: childConfig.toolCeiling,
                        },
                    }]);
                    const receipts = await client._catalog.getSessionEvents(child.sessionId, undefined, 10, ["test.model_tool_offer"]);
                    expect(receipts).toHaveLength(1);
                    expect(receipts[0].data.source).toBe("actual-copilot-cli-request");
                    expect(receipts[0].data.toolNames).toEqual(["read_facts"]);
                    const activities = await scheduledActivities(client, parentId);
                    console.info("REAL_SESSION_CAN_RESULT", JSON.stringify({
                        oldRoot: OLD_83, currentRoot: CURRENT, activities,
                        executions: await dx.listExecutions(`session-${parentId}`),
                        version: (await dx.getInstanceInfo(`session-${parentId}`)).orchestrationVersion,
                        childTools: offers[2], childConfig, childActivities, durableOfferReceipt: receipts[0],
                        preservedChild: oldChildId, replayedEvents: oldHistory.length, legacyParity: offers[0],
                        factResult: JSON.parse(factResults[2][0]),
                    }));
                    expect(await dx.listExecutions(`session-${parentId}`)).toEqual([1, 2]);
                    expect(activities).toContain("runTurnV5");
                    expect(activities).toContain("runTurnV6");
                    expect(offers[2]).toContain("read_facts");
                    expect(await client._catalog.getSessionCreationConfig(oldChildId)).toEqual(oldChildConfig);
                } finally {
                    await management.stop();
                }
            });
        } finally {
            await model.close();
        }
    });

    it("offers an identical ordinary child tool set on actual 0.8.11 and Release A", { timeout: 300_000 }, async () => {
        const env = getEnv();
        await assertSourceVersions(PRODUCTION);
        const offers = [];
        const factResults = [];
        const model = await startScriptedModel({ respond: responder(offers, factResults) });
        try {
            const helpers = await moduleAt(PRODUCTION, "test/helpers/scripted-workers.js");
            const providerPath = await helpers.registerScriptedProvider(env, model.baseUrl);
            const production = await spawnProbe(PRODUCTION, env, offers, factResults, providerPath);
            const current = await spawnProbe(CURRENT, env, offers, factResults, providerPath);
            console.info("REAL_ORDINARY_CHILD_PARITY", JSON.stringify({
                productionRoot: PRODUCTION, currentRoot: CURRENT, production, current,
            }));
            expect(current.version).toBe("1.0.84");
            expect(current.activities).toContain("runTurnV6");
            expect(current.tools).toEqual(production.tools);
        } finally {
            await model.close();
        }
    });
});
