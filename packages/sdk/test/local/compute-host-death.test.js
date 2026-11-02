/**
 * A host that dies under a warm session does not leave the session stuck
 * on it (docs/proposals/compute-providers.md, "When a host goes away").
 *
 * The worker keeps a pooled client per runtime connection and a warm
 * handle per session. When the host goes, both of them are reaching
 * something that is not there. The next turn must get a fresh host, or
 * fail saying so — never sit against a dead one until the session is
 * evicted, with every failed turn putting that eviction off further.
 *
 * Run: npx vitest run test/local/compute-host-death.test.js
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createProcessComputeProvider } from "../../src/compute-process.ts";

const TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);

async function registerTarget(env, name) {
    const catalog = await createCatalog(env);
    try {
        await catalog.computeTargets.create({ name: `shared/${name}`, kind: "process", class: "shared", displayName: name }, null, true);
    } finally {
        await catalog.close?.();
    }
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === "EPERM";
    }
}

const until = async (probe, what, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await probe()) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
};

describe("a compute host that dies", () => {
    it("gives the next turn a fresh host, with the conversation whole", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await registerTarget(env, "host-death");
        const provider = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-death") });
        const marker = `death-${env.runId}`;

        const respond = (body, position) => {
            if (position.lastUserText.includes("second prompt")) {
                const sawHistory = JSON.stringify(body.messages).includes(`one:${marker}`);
                return { content: `two:${sawHistory ? "history" : "no-history"}` };
            }
            return { content: `one:${marker}` };
        };

        await withScriptedModel(env, { respond, worker: { computeProviders: [provider] } }, async ({ client, qualifiedModel }) => {
            const session = await client.createSession({ model: qualifiedModel, computeTarget: "shared/host-death" });
            expect(await session.sendAndWait("first prompt", TIMEOUT)).toBe(`one:${marker}`);

            const [host] = provider.hosts();
            expect(host).toBeTruthy();
            const firstPid = host.pid;

            // The host is killed outright, while the worker still holds a
            // warm handle and a pooled client reaching it.
            process.kill(firstPid, "SIGKILL");
            await until(() => !isAlive(firstPid), "the host to die");
            await until(() => provider.hosts().length === 0, "the provider to notice the host is gone");

            // The next turn is answered, from a different host, and the
            // conversation it resumes is the one the worker kept.
            expect(await session.sendAndWait("second prompt", TIMEOUT)).toBe("two:history");
            const [replacement] = provider.hosts();
            expect(replacement).toBeTruthy();
            expect(replacement.pid).not.toBe(firstPid);
        });
        await provider.stopAll();
    });
});
