/**
 * Concurrent first sessions on one pooled Copilot client, with the real
 * Copilot CLI and a synthetic model endpoint (no credentials).
 *
 * Without one shared start per client, each concurrent first session start
 * spawned its own CLI process. Every session then talked to the last process
 * over several connections, so each event and each tool call reached it once
 * per process, and the extra processes kept running after shutdown.
 *
 * Counts CLI processes with `pgrep -P` (macOS and Linux).
 *
 * Run: npx vitest run test/local/copilot-client-start-cli.test.js
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { SessionManager } from "../../src/session-manager.ts";
import { createCopilotProviderServer } from "../helpers/copilot-provider-server.mjs";

const SESSIONS = 3;
const MODEL = "anthropic:claude-sonnet-5";

/** Direct child processes of this test process. */
function childPids() {
    try {
        return execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {
        return []; // pgrep exits 1 when there are none
    }
}

// No facts are used by this fixture.
const facts = {
    readFacts: async () => ({ count: 0, facts: [] }),
    storeFact: async () => ({ stored: true }),
    deleteFact: async () => ({ deleted: true }),
};

describe("Copilot client start (real SDK/CLI, synthetic HTTP)", () => {
    it.skipIf(process.platform === "win32")(
        "concurrent first sessions share one CLI process and see each tool call once",
        { timeout: 120_000 },
        async () => {
        const home = mkdtempSync(join(tmpdir(), "ps-client-start-"));
        const server = await createCopilotProviderServer();
        const registry = new ModelProviderRegistry({ providers: [
            { id: "anthropic", type: "anthropic", baseUrl: server.baseUrl, apiKey: "synthetic-key", models: ["claude-sonnet-5"] },
        ] });
        const manager = new SessionManager(undefined, null, { modelProviders: registry }, join(home, "session-state"));
        manager.setFactStore(facts);

        const ids = Array.from({ length: SESSIONS }, () => randomUUID());
        const toolRuns = new Map(ids.map((id) => [id, 0]));
        for (const id of ids) {
            manager.setConfig(id, { tools: [{
                name: "compat_echo",
                description: "Echo the supplied value.",
                parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
                handler: async (args) => {
                    toolRuns.set(id, toolRuns.get(id) + 1);
                    return args.value;
                },
            }] });
        }

        const before = new Set(childPids());
        let spawned = [];
        let leftover = [];
        let turns = [];
        try {
            const sessions = await Promise.all(ids.map((id) => manager.getOrCreate(id, { model: MODEL }, { turnIndex: 0 })));
            spawned = childPids().filter((pid) => !before.has(pid));
            turns = await Promise.all(sessions.map(async (session) => {
                const completions = [];
                const result = await session.runTurn("call compat_echo with value violet-739", {
                    onEvent: (event) => {
                        if (event.eventType === "tool.execution_complete") completions.push(event);
                    },
                });
                return { content: result.content, completions: completions.length };
            }));
        } finally {
            await manager.shutdown();
            // Give stopped processes a moment to exit, then remove any that did not.
            for (let i = 0; i < 20 && childPids().some((pid) => !before.has(pid)); i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            leftover = childPids().filter((pid) => !before.has(pid));
            for (const pid of leftover) {
                try { process.kill(Number(pid), "SIGKILL"); } catch {}
            }
            await server.close();
            rmSync(home, { recursive: true, force: true });
        }

        expect(spawned).toHaveLength(1);
        for (const [k, id] of ids.entries()) {
            expect(turns[k].content).toContain("violet-739");
            expect(toolRuns.get(id)).toBe(1);
            expect(turns[k].completions).toBe(1);
        }
        expect(leftover).toEqual([]);
        },
    );
});
