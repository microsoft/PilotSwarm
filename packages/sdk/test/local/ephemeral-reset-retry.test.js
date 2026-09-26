// Retry behaviour at a context-reset boundary.
//
// The reset tool call is the model's to make, and a live model does decline it.
// A decline leaves the window untouched, so the boundary asks again rather than
// failing on the first refusal — but only a bounded number of times, because an
// unprovable window has to end the run instead of continuing on a stale one.
//
// A live model cannot be made to decline on cue, so both paths are driven here
// through a real scripted endpoint whose reply is chosen by the test.
import { describe, it, expect } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { createEphemeralSessionRunner } from "../../dist/ephemeral-session.js";
import { createEphemeralClient } from "../../dist/ephemeral-client.js";
import { RESET_ATTEMPTS } from "../../dist/ephemeral-context-reset.js";
import { loadProviderTypes } from "../../src/provider-catalog.ts";
import { WIRES, createScriptedWire } from "../helpers/scripted-wires.mjs";

const MODEL = "gpt-5.6-terra";
const WIRE = WIRES.openai;
const SEEDED_REPLY = "Ready for the next instruction.";
const DECLINED = "All done, nothing further is needed.";

function credentialCatalog() {
    return {
        async getUserRole() { return { role: "user", roleSeenAt: null }; },
        providers: {
            async lookupUserId() { return 1; },
            async getCredential() {
                return { name: "synthetic", typeId: "template", class: "shared",
                    ownerUserId: null, baseUrl: null, secretRef: { value: "synthetic-only-key" } };
            },
        },
    };
}

/**
 * Drives one two-batch run whose scripted model refuses the reset tool on the
 * first `declines` attempts, and reports what the boundary did about it.
 */
async function runWithDeclines(declines, { failResetRequest = 0 } = {}) {
    const batches = 2;
    const root = path.resolve(`.ephemeral-retry-${randomUUID()}`);
    const cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
    await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });

    const canaries = Array.from({ length: batches }, (_v, i) => `CANARY-${i}-${randomUUID().slice(0, 8)}`);
    const prompts = Array.from({ length: batches }, (_v, i) => `BATCH ${i} WORK ${randomUUID().slice(0, 8)}`);
    const phases = [], events = [];
    let seen = 0;

    const server = await createScriptedWire(WIRE, (messages, tools) => {
        const last = messages.at(-1) ?? {};
        const index = prompts.findIndex(prompt => String(last.content ?? "").includes(prompt));
        if (index >= 0) { phases.push(`batch-${index}`); return { content: `Finished batch ${index}. ${canaries[index]}` }; }
        if (messages.some(message => message.toolCalls > 0)) { phases.push("reset-seeded"); return { content: SEEDED_REPLY }; }
        const tool = tools.find(entry => typeof entry === "string" && entry.includes("context_reset"));
        if (tool) {
            seen++;
            // A provider failure is not a decline. Scripted as a 500 so the
            // runtime sees a real transport error on the reset turn.
            if (seen === failResetRequest) { phases.push("reset-error"); throw new Error("scripted provider failure"); }
            // Answering in prose is exactly how a live model declines: the turn
            // completes normally, it simply never calls the tool.
            if (seen <= declines) { phases.push("reset-declined"); return { content: DECLINED }; }
            phases.push("reset-call"); return { tool };
        }
        phases.push("unexpected"); return { content: "UNEXPECTED" };
    });

    const types = loadProviderTypes({ providers: [
        { id: "template", type: WIRE.type, baseUrl: server.baseUrl, models: [MODEL] }] });
    try {
        const run = createEphemeralSessionRunner(credentialCatalog(), () => types, {
            scratchRoot: scratch,
            createClient: (options, provider) => {
                const client = createEphemeralClient(options, provider, () => {}, () => {});
                return { ...client, async createSession(config) {
                    return client.createSession({ ...config, onEvent(event) {
                        events.push(event); config.onEvent?.(event);
                    } });
                } };
            },
        });
        let turn = 0;
        const responses = [];
        const outcome = await run({
            actor: { provider: "fixture", subject: "test" }, executionId: randomUUID(),
            model: `synthetic:${MODEL}`, workingDirectory: cwd,
            systemMessage: "Private synthetic system", prompt: prompts[0], contextReset: true,
            onResponse: async value => { responses.push(value.text); turn++;
                return turn < batches ? { action: "clear_context", prompt: prompts[turn] } : { action: "complete" }; },
        }).then(result => ({ result }), error => ({ error }));
        return { ...outcome, phases, events, responses, server, canaries, prompts, batches };
    } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
}

describe("ephemeral context reset retries a declined tool call", () => {
    it.concurrent("a refusal is re-prompted and the boundary still lands clean",
        { timeout: 180000 }, async () => {
            const { result, error, phases, events, responses, server, canaries, prompts, batches }
                = await runWithDeclines(1);
            expect(error).toBeUndefined();

            // The refusal happened, and was answered by asking again.
            expect(phases.filter(phase => phase === "reset-declined").length).toBe(1);
            expect(phases.filter(phase => phase === "reset-call").length).toBe(1);
            expect(phases.filter(phase => phase === "unexpected")).toEqual([]);

            // The run finished normally: both batches ran, and the internal
            // turns — refusal included — never reached the host.
            expect(result.turnCount).toBe(batches);
            expect(responses.length).toBe(batches);
            expect(result.text).toContain(canaries[batches - 1]);
            expect(responses.some(text => text.includes(DECLINED) || text.includes(SEEDED_REPLY))).toBe(false);

            // The window is still proven clean, from the runtime's own event.
            const cleared = events.filter(event => event.type === "session.context_cleared");
            expect(cleared.length).toBe(batches - 1);
            const real = server.requests.filter(body =>
                prompts.some(prompt => JSON.stringify(WIRE.messages(body).at(-1) ?? {}).includes(prompt)));
            const window = JSON.stringify(WIRE.messages(real[1]));
            expect(window).not.toContain(canaries[0]);
            expect(window).not.toContain(prompts[0]);
            expect(window).not.toContain(DECLINED);

            // Every attempt is real inference and every one is charged:
            // batch 0, the refused turn, the accepted turn, its seeded
            // continuation, then batch 1.
            expect(server.requests.length).toBe(5);
            expect(result.usage.apiCalls).toBe(5);

            // The boundary happens between batches and nowhere else: no reset
            // is attempted after the host completes.
            expect(phases.at(-1)).toBe(`batch-${batches - 1}`);
        });

    it.concurrent("a boundary that is never honoured fails closed after a bounded number of attempts",
        { timeout: 180000 }, async () => {
            const { result, error, phases, events, server } = await runWithDeclines(Number.POSITIVE_INFINITY);
            expect(result).toBeUndefined();
            expect(error?.code).toBe("EPHEMERAL_RESET_FAILED");

            // Bounded: it asked exactly as many times as it is allowed to, and
            // stopped rather than carrying on with the previous batch's window.
            expect(phases.filter(phase => phase === "reset-declined").length).toBe(RESET_ATTEMPTS);
            expect(phases.filter(phase => phase === "batch-1")).toEqual([]);
            expect(events.filter(event => event.type === "session.context_cleared").length).toBe(0);
            expect(server.requests.length).toBe(1 + RESET_ATTEMPTS);
        });

    it.concurrent("a provider failure on the reset turn is not retried as a decline",
        { timeout: 180000 }, async () => {
            // The first reset request fails at the transport. That is not the
            // model declining, so it must stop the run rather than consume an
            // attempt and ask again.
            const { result, error, phases, events, server } = await runWithDeclines(0, { failResetRequest: 1 });
            expect(result).toBeUndefined();
            expect(error?.code).toBe("EPHEMERAL_RESET_FAILED");
            expect(phases.filter(phase => phase === "reset-error").length).toBe(1);
            expect(phases.filter(phase => phase === "reset-declined")).toEqual([]);
            expect(phases.filter(phase => phase === "batch-1")).toEqual([]);
            expect(events.filter(event => event.type === "session.context_cleared").length).toBe(0);
            // One batch request and exactly one reset request: no second try.
            expect(server.requests.length).toBe(2);
        });
});
