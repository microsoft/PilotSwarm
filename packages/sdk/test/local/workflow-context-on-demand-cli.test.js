/**
 * Workflows on demand through the real Copilot CLI (scripted local inference, no database): what the chat records for
 * enable_workflows, and the row the portal draws from it (chat-activity.js appendChatCall: success false or an error is
 * "Failed").
 *
 * Deployed UX check: a chat showed "enable_workflows Failed" although Workflows were on. The activation call itself is
 * recorded as a success (its result {"workflows":"on"} and the turn-boundary note). A call after they are on reached a
 * CLI session that was no longer declared the tool, and the CLI refused it itself ("Tool 'enable_workflows' does not
 * exist."): a Failed row. A chat whose Workflows are on demand now keeps the tool declared once they are on; the call is
 * answered "already on" and recorded as a success. Two calls in one response (the CLI runs them at once) give one
 * activation and one continuation.
 *
 * Run: npx vitest run test/local/workflow-context-on-demand-cli.test.js
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";
import { createFeaturePolicy } from "../helpers/feature-policy.mjs";
import { appendChatCall } from "../../../app/ui/core/src/chat-activity.js";

const MODEL = "gpt-5.6-terra";
const owner = { provider: "test", subject: "workflow-context-cli", email: null, displayName: null };

/** A chat on a manager with durable capability storage (in memory, compare-and-set), the real CLI and a scripted model. */
async function harness(respond, run) {
    const home = mkdtempSync(join(tmpdir(), "ps-workflow-context-cli-"));
    const sessionId = randomUUID();
    let state = { revision: 0, selections: [] };
    const saves = [];
    const row = { sessionId, owner, isSystem: false, parentSessionId: null, rootSessionId: sessionId };
    const catalog = {
        getSession: async id => (id === sessionId ? row : null),
        getUserRole: async () => ({ role: "user", seenAt: new Date() }),
        recordEvents: async () => {},
        getSessionCapabilities: async () => structuredClone(state),
        saveSessionCapabilities: async (_id, expected, next) => {
            saves.push(structuredClone(next));
            if (state.revision !== expected) return false;
            state = structuredClone(next);
            return true;
        },
    };
    const server = await createNativeCopilotProvider(respond);
    const registry = new ModelProviderRegistry({ providers: [{ id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: [MODEL] }] });
    const policy = await createFeaturePolicy();
    const manager = new SessionManager(undefined, null, { nativeSubagents: "sync", modelProviders: registry, turnTimeoutMs: 30_000 }, join(home, "session-state"));
    manager.workflowScriptsEnabled = true;
    manager.setFeatureFlagCache(policy.cache);
    manager.setSessionCatalog(catalog);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    const config = { model: `fixture:${MODEL}`, workingDirectory: home, workflowMilestoneTurn: true };
    const turn = async (index, prompt) => {
        const events = [];
        const managed = await manager.getOrCreate(sessionId, { ...config }, { turnIndex: index });
        const result = await managed.runTurn(prompt, { onEvent: event => events.push(event) });
        return { result, events };
    };
    try {
        await run({ turn, saves, sessionId, get state() { return state; } });
    } finally {
        await manager.shutdown();
        await policy.cache.stop();
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
}

const declared = body => (body.tools ?? []).map(tool => tool.function?.name);
const completions = events => events.filter(event => event.eventType === "tool.execution_complete" && event.data?.toolName === "enable_workflows");
const resultText = event => event.data?.result?.content ?? "";
/** The rows the portal draws from these events (chat-activity.js), as history.js feeds them. */
function rows(sessionId, ...turns) {
    const chat = [];
    let seq = 0;
    for (const events of turns) {
        for (const event of events) appendChatCall(chat, { ...event, sessionId, seq: ++seq, createdAt: new Date().toISOString() });
    }
    return chat.filter(item => item.kind === "chat-call" && item.name === "enable_workflows").map(item => item.status);
}

describe("enable_workflows through the real CLI: the recorded tool event and its row", () => {
    it("the activation is a success, and a later call after Workflows are on is answered 'already on' (not refused by the CLI)", { timeout: 60_000 }, async () => {
        const requests = [];
        await harness(body => {
            requests.push(body);
            if (body.messages.at(-1).role === "tool") return { content: "Done." };
            // The model calls enable_workflows in both turns: in the second its call comes after Workflows are on.
            return { tools: [{ name: "enable_workflows", args: {} }] };
        }, async (h) => {
            const { turn, saves, sessionId } = h;
            const first = await turn(0, "watch the build every minute");
            expect(first.result.forceContinuePrompt).toMatch(/^Workflows are now on in this chat/);
            expect(h.state.workflows).toBe(true);
            const [activation] = completions(first.events);
            expect(activation.data.success).toBe(true);
            expect(activation.data.error).toBeUndefined();
            expect(resultText(activation)).toMatch(/^\{"workflows":"on"\}\n\[SYSTEM: enable_workflows acknowledged/);

            const second = await turn(1, first.result.forceContinuePrompt);
            const [again] = completions(second.events);
            expect(rows(sessionId, first.events, second.events)).toEqual(["Done", "Done"]);
            expect(again.data.success, JSON.stringify(again.data)).toBe(true);
            expect(again.data.error).toBeUndefined();
            expect(resultText(again)).toMatch(/already on in this chat/);
            expect(second.result.forceContinuePrompt).toBeUndefined();
            expect(saves).toHaveLength(1);
            const continued = requests.at(-2);
            expect(declared(continued)).toContain("workflow_definition");
            expect(declared(continued)).toContain("enable_workflows");
        });
    });

    it("two calls in one response: one activation, one continuation, both rows Done", { timeout: 60_000 }, async () => {
        await harness(body => {
            if (body.messages.at(-1).role === "tool") return { content: "Done." };
            return { tools: [{ name: "enable_workflows", args: {} }, { name: "enable_workflows", args: {} }] };
        }, async ({ turn, saves, sessionId }) => {
            const { result, events } = await turn(0, "watch the build every minute");
            expect(result.forceContinuePrompt).toMatch(/^Workflows are now on in this chat/);
            expect(result.queuedActions ?? []).toEqual([]);
            const done = completions(events);
            expect(done).toHaveLength(2);
            expect(done.every(event => event.data.success === true)).toBe(true);
            expect(done.filter(event => resultText(event).startsWith('{"workflows":"on"}'))).toHaveLength(1);
            expect(saves).toHaveLength(1);
            expect(rows(sessionId, events)).toEqual(["Done", "Done"]);
        });
    });
});
