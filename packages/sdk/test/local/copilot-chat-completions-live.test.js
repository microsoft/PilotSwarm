/**
 * Live: a GitHub Copilot model that the Copilot runtime cannot reach natively,
 * served through Copilot's own Chat Completions API as an `openai` provider
 * type with a catalog `headers` entry.
 *
 * Copilot lists some models (Gemini, when this was written) only on
 * /chat/completions. The pinned runtime reaches Copilot models only through
 * /responses and /v1/messages, and answers an id it does not know with a
 * different model, without an error. Declared as an `openai` type whose
 * baseUrl is Copilot's API, with Copilot's integration header, the requested
 * model answers itself. Without the header Copilot refuses the model.
 *
 * Opt-in: PILOTSWARM_LIVE_MODEL_TESTS=1 and GITHUB_TOKEN (a GitHub token with
 * Copilot access). PILOTSWARM_COPILOT_API_URL overrides the endpoint and
 * PILOTSWARM_COPILOT_CHAT_MODEL the model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../src/session-manager.ts";
import { buildRuntimeRegistry, loadProviderTypes } from "../../src/provider-catalog.ts";

const LIVE = process.env.PILOTSWARM_LIVE_MODEL_TESTS === "1";
const BASE_URL = process.env.PILOTSWARM_COPILOT_API_URL || "https://api.githubcopilot.com";
const MODEL = process.env.PILOTSWARM_COPILOT_CHAT_MODEL || "gemini-4-argon";
const WINDOW = 983_040;
const TYPE_ID = "github-copilot-gemini-only";
const INTEGRATION = { "Copilot-Integration-Id": "copilot-developer-cli" };
const FACTS = { readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }) };

/** A personal instance of the type, holding the caller's own GitHub token. */
function personalRegistry(headers) {
    const types = loadProviderTypes({ providers: [{
        id: TYPE_ID, type: "openai", wireApi: "completions", baseUrl: BASE_URL,
        ...(headers ? { headers } : {}),
        models: [{
            name: MODEL,
            supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium",
            supportedContextTiers: ["default"], defaultContextTier: "default", contextWindowSizes: { default: WINDOW },
        }],
    }] });
    return buildRuntimeRegistry(types, [{
        name: "my-copilot-chat", typeId: TYPE_ID, class: "personal", ownerUserId: "live-test-user",
        baseUrl: null, secretRef: { kind: "apiKey", value: process.env.GITHUB_TOKEN },
    }], `my-copilot-chat:${MODEL}`);
}

describe.skipIf(!LIVE)(`a Copilot model reached through Copilot's Chat Completions API (live, ${MODEL})`, () => {
    let home;
    beforeAll(() => {
        if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN required for opt-in live evaluation");
        home = mkdtempSync(join(tmpdir(), "ps-copilot-chat-live-"));
    });
    afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

    function manager(registry, sessionId, tools) {
        const m = new SessionManager(undefined, null, { modelProviders: registry }, join(home, "session-state"));
        m.setFactStore(FACTS);
        m.setConfig(sessionId, { tools });
        return m;
    }

    async function turn(m, sessionId, prompt, turnIndex) {
        const events = [];
        const session = await m.getOrCreate(sessionId, { model: `my-copilot-chat:${MODEL}`, reasoningEffort: "high" }, { turnIndex });
        const result = await session.runTurn(prompt, { turnIndex, onEvent: event => events.push(event) });
        return {
            result,
            served: events.filter(e => e.eventType === "assistant.usage").map(e => e.data.model),
            tokenLimits: events.filter(e => e.eventType === "session.usage_info").map(e => e.data.tokenLimit),
        };
    }

    it("answers as the requested model with a tool call, the declared window, and a cold resume", { timeout: 240_000 }, async () => {
        const registry = personalRegistry(INTEGRATION);
        const sessionId = randomUUID();
        const token = `token-${randomUUID().slice(0, 8)}`;
        let calls = 0;
        const tools = [{
            name: "read_validation_token", description: "Return the validation token for this test.",
            parameters: { type: "object", properties: {} },
            handler: async () => { calls++; return token; },
        }];
        let m = manager(registry, sessionId, tools);
        try {
            const first = await turn(m, sessionId, "Call the read_validation_token tool once, then reply with only the token it returned.", 0);
            expect(first.result.content, JSON.stringify(first.result)).toContain(token);
            expect(calls).toBe(1);
            expect(first.served.length).toBeGreaterThan(0);
            expect(new Set(first.served)).toEqual(new Set([MODEL]));
            expect(first.tokenLimits).toContain(WINDOW);
            await m.shutdown();

            // New manager and runtime process: the transcript, including the
            // model's own reasoning items, must replay to the same model.
            m = manager(registry, sessionId, tools);
            const second = await turn(m, sessionId, "Without calling any tool, reply with only the validation token from earlier.", 1);
            expect(second.result.content, JSON.stringify(second.result)).toContain(token);
            expect(calls).toBe(1);
            expect(new Set(second.served)).toEqual(new Set([MODEL]));
        } finally { await m.shutdown(); }
    });

    it("without the integration header, Copilot refuses the model rather than another model answering", { timeout: 120_000 }, async () => {
        const sessionId = randomUUID();
        const m = manager(personalRegistry(undefined), sessionId, []);
        try {
            let outcome;
            try {
                outcome = await turn(m, sessionId, "Reply with OK.", 0);
            } catch (error) {
                outcome = { error: String(error?.message ?? error) };
            }
            expect(outcome.served ?? []).toEqual([]);
            expect(JSON.stringify(outcome)).toMatch(/integrator/i);
        } finally { await m.shutdown(); }
    });
});
