import { describe, expect, it, vi } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "real-session-upgrade" };
const CHILD = "REAL_UPGRADE_CHILD: report the harmless fact fixture.";
const SPAWN = "REAL_UPGRADE_SPAWN";
const OLD_83 = process.env.PS_UPGRADE_83_ROOT;
const PRODUCTION = process.env.PS_UPGRADE_PRODUCTION_ROOT;
const CURRENT = process.env.PS_UPGRADE_CURRENT_ROOT;

async function moduleAt(root, path) {
    if (!root) throw new Error("Real-source session upgrade requires the production, 1.0.83 and current source roots.");
    return import(/* @vite-ignore */ `${root}/packages/sdk/${path}`);
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

function responder(offers) {
    return (body, position) => {
        if (position.firstUserText.includes(CHILD)) {
            if (position.step === 0) {
                offers.push((body.tools ?? []).map(tool => tool.function.name).sort());
                return { tools: [{ name: "read_facts", args: {} }] };
            }
            expect(position.toolResults.join("\n")).not.toMatch(/Tool failed|unavailable|not authorized/i);
            return { content: "CHILD_FACTS_READ" };
        }
        if (position.lastUserText.includes(SPAWN) && position.step === 0) {
            return { tools: [{ name: "spawn_agent", args: { task: CHILD, tool_names: ["read_facts"] } }] };
        }
        return { content: "ok" };
    };
}

async function spawnProbe(root, env, offers, providerPath) {
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
    });
    return result;
}

describe.skipIf(!OLD_83 && !PRODUCTION && !CURRENT)("real-source session upgrade and ordinary spawn parity", () => {
    it("continues an actual 1.0.83 session as new into 1.0.84 and dispatches composition turns", { timeout: 300_000 }, async () => {
        const env = getEnv();
        const offers = [];
        const model = await startScriptedModel({ respond: responder(offers) });
        let parentId;
        let providerPath;
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
                    const parent = await client.resumeSession(parentId);
                    expect(await parent.sendAndWait(SPAWN, 60_000)).toBe("ok");
                    await vi.waitFor(() => expect(offers.length).toBeGreaterThan(0), { timeout: 60_000 });
                    const activities = await scheduledActivities(client, parentId);
                    console.info("REAL_SESSION_CAN_RESULT", JSON.stringify({
                        oldRoot: OLD_83, currentRoot: CURRENT, activities,
                        executions: await dx.listExecutions(`session-${parentId}`),
                        version: (await dx.getInstanceInfo(`session-${parentId}`)).orchestrationVersion,
                        childTools: offers[0],
                    }));
                    expect((await dx.listExecutions(`session-${parentId}`)).length).toBeGreaterThan(1);
                    expect(activities).toContain("runTurnV5");
                    expect(activities).toContain("runTurnV6");
                    expect(offers[0]).toContain("read_facts");
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
        const offers = [];
        const model = await startScriptedModel({ respond: responder(offers) });
        try {
            const helpers = await moduleAt(PRODUCTION, "test/helpers/scripted-workers.js");
            const providerPath = await helpers.registerScriptedProvider(env, model.baseUrl);
            const production = await spawnProbe(PRODUCTION, env, offers, providerPath);
            const current = await spawnProbe(CURRENT, env, offers, providerPath);
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
