/**
 * Cron prechecks shipped by an agent package, end to end: a package is
 * published to the registry, a real worker installs it, and a session bound to
 * its agent arms cron WITHOUT naming a precheck. The agent definition's
 * `cronPrechecks` reason binding attaches the precheck the package's
 * tools/worker-module.js exports. The model is scripted, so every request is
 * counted: empty cycles must make none.
 *
 * Run: npx vitest run test/local/cron-precheck-package-live.test.js
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { scriptTurns } from "../helpers/scripted-model.mjs";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { FilesystemArtifactStore, publishAgentPackageDir } from "../../src/index.ts";
import { startPrecheckMcpServer } from "../helpers/cron-precheck-mcp.mjs";

const TIMEOUT = 240_000;
const OWNER = { provider: "test", subject: "cron-precheck-package-owner" };
const AGENT = "queue-poller";
const REASON = "Run the fixture queue cycle (scope=both)";
const KICKOFF = "start the fixture queue cycle";
const getEnv = useSuiteEnv(import.meta.url);

async function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${label}`);
}

function writePackage(dir, mcpConfig) {
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name: "precheck-kit", version: "1.0.0", description: "cron precheck fixture",
    }));
    if (mcpConfig) fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ queue: mcpConfig }));
    fs.writeFileSync(path.join(dir, "agents", `${AGENT}.agent.md`), [
        "---",
        `name: ${AGENT}`,
        "description: Fixture poller whose queue cycle is prechecked",
        `schemaVersion: ${mcpConfig ? 2 : 1}`,
        "version: 1.0.0",
        ...(mcpConfig ? ["mcpServers:", "  - queue"] : []),
        "cronPrechecks:",
        "  - reasonPrefix: \"Run the fixture queue cycle\"",
        "    precheck: queue-gate",
        "---",
        "",
        "You poll the fixture queue.",
    ].join("\n"));
    // The precheck reads shared state the test controls. Packages must not
    // use bare imports, so the fixture keeps it on globalThis.
    fs.writeFileSync(path.join(dir, "tools", "worker-module.js"), [
        "const state = (globalThis.__cronPrecheckFixture ??= { hasWork: false, calls: [] });",
        "export default {",
        "    createTools: () => [],",
        "    createCronPrechecks: () => [{",
        "        name: \"queue-gate\",",
        "        check: async ({ sessionId, reason, consecutiveSkips, callMcpTool }) => {",
        "            state.calls.push({ sessionId, reason, consecutiveSkips });",
        ...(mcpConfig ? [
            "            const result = await callMcpTool('queue', 'queue_status', { scope: 'both' });",
            "            const hasWork = result.structuredContent?.hasWork;",
            "            if (typeof hasWork !== 'boolean') throw new Error('Invalid queue result');",
        ] : ["            const hasWork = state.hasWork;"]),
        "            return hasWork ? { action: \"run\", detail: \"one job\" } : { action: \"skip\", detail: \"queue empty\" };",
        "        },",
        "    }],",
        "};",
        "",
    ].join("\n"));
    return dir;
}

describe("package cron precheck (live)", () => {
    it.each([false, true])("a package precheck (MCP=%s) skips empty cycles without model calls", { timeout: TIMEOUT }, async (mcp) => {
        const env = await getEnv();
        const fixture = mcp ? await startPrecheckMcpServer({ stateful: true }) : null;
        const state = (globalThis.__cronPrecheckFixture ??= { hasWork: false, calls: [] });
        const catalog = await createCatalog(env);
        const artifactStore = new FilesystemArtifactStore(path.join(path.dirname(env.sessionStateDir), "artifacts"));
        try {
            await publishAgentPackageDir({ catalog, artifactStore }, {
                dir: writePackage(path.join(env.baseDir, "precheck-kit"), fixture?.config),
                scope: "shared", owner: OWNER, createdBy: "fixture@test", isAdmin: false,
            });
            const respond = scriptTurns([
                [{ tools: [{ name: "cron", args: { seconds: 15, reason: REASON } }] }, { content: "armed" }],
                [{ content: "cycle ran" }],
            ]);
            await withScriptedModel(env, {
                respond,
                worker: { agentPackages: { cacheDir: path.join(env.baseDir, "agent-packages-cache"), refreshIntervalMs: 0 } },
            }, async ({ client, model }) => {
                const session = await client.createSessionForAgent(AGENT, { title: "precheck-package" });
                await session.send(KICKOFF);
                const [started] = await waitForEventCount(catalog, session.sessionId, "session.cron_started", 1, 60_000);
                expect(started.data).toMatchObject({ reason: REASON, precheck: "queue-gate" });
                const armedRequests = model.sessionRequests(KICKOFF).length;
                const armedMcpSessions = fixture ? new Set(fixture.state.sessions) : null;

                await waitForEventCount(catalog, session.sessionId, "session.cron_precheck", 2, 75_000);
                expect(model.sessionRequests(KICKOFF).length).toBe(armedRequests);
                expect(state.calls.slice(0, 2).map((call) => [call.sessionId, call.reason, call.consecutiveSkips])).toEqual([
                    [session.sessionId, REASON, 0],
                    [session.sessionId, REASON, 1],
                ]);

                state.hasWork = true;
                if (fixture) {
                    expect(fixture.state.calls.length).toBeGreaterThanOrEqual(2);
                    expect(fixture.state.calls[0]).toEqual({ name: "queue_status", arguments: { scope: "both" } });
                    expect(fixture.state.terminations.length).toBeGreaterThanOrEqual(2);
                    expect(fixture.state.sessions).toEqual(armedMcpSessions);
                    fixture.state.hasWork = true;
                }
                await waitFor(() => model.sessionRequests(KICKOFF).length > armedRequests, 45_000, "the model to run a cycle");
                const events = (await catalog.getSessionEvents(session.sessionId, undefined, 500, ["session.cron_precheck"]))
                    .map((event) => event.data);
                expect(events.slice(0, 2).map((e) => [e.precheck, e.outcome, e.skipped])).toEqual([
                    ["queue-gate", "skip", true],
                    ["queue-gate", "skip", true],
                ]);
                expect(events.some((e) => e.outcome === "run" && e.skipped === false)).toBe(true);
            });
        } finally {
            delete globalThis.__cronPrecheckFixture;
            await catalog.close();
            if (fixture) await fixture.close();
        }
    });
});
