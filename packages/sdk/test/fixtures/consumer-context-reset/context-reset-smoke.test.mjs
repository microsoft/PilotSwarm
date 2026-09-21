// Self-contained qualification smoke for an INSTALLED pilotswarm-sdk tarball.
//
// It needs no provider credentials, no database and no PilotSwarm checkout: it
// stands up a scripted OpenAI-compatible endpoint on loopback, drives a real
// ephemeral session through a batch boundary, and asserts against the actual
// provider request bodies that nothing from the earlier batch survives.
//
//   npm i ./pilotswarm-sdk-<version>.tgz vitest
//   npx vitest run context-reset-smoke.test.mjs
//
// Canaries are spoken only by the model and never appear in any prompt, so
// finding one in a later window proves real carryover rather than prompt echo.
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { loadProviderTypes } from "pilotswarm-sdk";

// The runner itself is a trusted server-side entry point that a host normally
// reaches through PilotSwarmHostServices, which needs a CMS. A qualification
// probe has no database, so resolve the installed package and load the runner
// directly. Nothing else here reaches past the public surface.
const installed = path.dirname(createRequire(import.meta.url).resolve("pilotswarm-sdk/package.json"));
const { createEphemeralSessionRunner } = await import(
    pathToFileURL(path.join(installed, "dist/ephemeral-session.js")).href);

// Minimal stand-in for the CMS-backed provider catalog the runner asks for.
const credentialCatalog = credential => ({
    async getUserRole() { return { role: "user", roleSeenAt: null }; },
    providers: {
        async lookupUserId() { return 1; },
        async getCredential(name) {
            if (name !== credential.name) throw new Error(`unexpected credential ${name}`);
            return credential;
        },
    },
});

const MODEL = process.env.SMOKE_MODEL || "gpt-5.6-terra";
const BATCHES = Number(process.env.SMOKE_BATCHES || 2);
// Deterministic stand-in for the model-written reply the runtime carries across
// a boundary. In production this is real model output.
const SEEDED_REPLY = "Ready for the next instruction.";

async function scriptedProvider(respond) {
    const requests = [];
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(body);
        const answer = respond(body);
        const id = `smoke-${requests.length}`;
        const calls = answer.tool ? [{ id: `${id}-0`, type: "function",
            function: { name: answer.tool, arguments: "{}" } }] : undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            id, object: "chat.completion", model: body.model,
            choices: [{ index: 0, finish_reason: calls ? "tool_calls" : "stop",
                message: { role: "assistant", content: answer.content ?? null, ...(calls ? { tool_calls: calls } : {}) } }],
            usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests,
        async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    };
}

describe("installed pilotswarm-sdk: inter-batch context reset", () => {
    it("carries no prior prompt or model-spoken canary across a boundary", { timeout: 180000 }, async () => {
        const root = path.resolve(`.consumer-reset-${randomUUID()}`);
        const cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        await mkdir(scratch, { mode: 0o700 });

        const canaries = Array.from({ length: BATCHES }, (_v, i) => `CANARY-${i}-${randomUUID().slice(0, 8)}`);
        const prompts = Array.from({ length: BATCHES }, (_v, i) => `BATCH ${i} WORK ${randomUUID().slice(0, 8)}`);

        // The reset turn is recognised structurally, from the tool the SDK
        // offers, so this probe needs no internal constants.
        const phases = [];
        const server = await scriptedProvider(body => {
            const last = body.messages.at(-1) ?? {};
            const index = prompts.findIndex(prompt => String(last.content ?? "").includes(prompt));
            if (index >= 0) { phases.push(`batch-${index}`); return { content: `Finished batch ${index}. ${canaries[index]}` }; }
            // The boundary is two requests. The second one already carries this
            // turn's tool call, which is how it is told apart without relying
            // on any internal constant or on a request counter.
            if (body.messages.some(message => Array.isArray(message.tool_calls) && message.tool_calls.length)) {
                phases.push("reset-seeded"); return { content: SEEDED_REPLY };
            }
            const tool = (body.tools ?? []).map(entry => entry.function?.name ?? entry.name)
                .find(name => typeof name === "string" && name.includes("context_reset"));
            if (tool) { phases.push("reset-call"); return { tool }; }
            phases.push("unexpected"); return { content: "UNEXPECTED" };
        });
        const types = loadProviderTypes({ providers: [{ id: "smoke", type: "openai", baseUrl: server.baseUrl, models: [MODEL] }] });
        const catalog = credentialCatalog({
            name: "smoke", typeId: "smoke", class: "shared", ownerUserId: null,
            baseUrl: null, secretRef: { value: "synthetic-only-key" },
        });

        try {
            const run = createEphemeralSessionRunner(catalog, () => types, { scratchRoot: scratch });
            let turn = 0;
            const result = await run({
                actor: { provider: "smoke", subject: "consumer" }, executionId: randomUUID(),
                model: `smoke:${MODEL}`, workingDirectory: cwd, systemMessage: "Consumer smoke",
                prompt: prompts[0], contextReset: true,
                onResponse: async () => (++turn < BATCHES
                    ? { action: "clear_context", prompt: prompts[turn] }
                    : { action: "complete" }),
            });
            expect(result.text).toContain(canaries[BATCHES - 1]);

            const real = server.requests.filter(body =>
                prompts.some(prompt => String(body.messages.at(-1)?.content ?? "").includes(prompt)));
            expect(real.length).toBe(BATCHES);
            for (let index = 1; index < BATCHES; index++) {
                const window = JSON.stringify(real[index]);
                for (let prior = 0; prior < index; prior++) {
                    expect(window).not.toContain(canaries[prior]);
                    expect(window).not.toContain(prompts[prior]);
                }
                // The one message the runtime carries across a boundary is the
                // seeded turn's reply. It is model-written in production and can
                // mention earlier work, so this pins what survives rather than
                // claiming the window is empty.
                expect(real[index].messages.filter(message => message.role === "assistant")
                    .map(message => String(message.content ?? ""))).toEqual([SEEDED_REPLY]);
                expect(real[index].messages[0].role).toBe("system");
                expect(JSON.stringify(real[index].messages[0])).toContain("Consumer smoke");
            }
            // Measured, not presumed: each boundary costs two provider requests
            // (the tool call, then the seeded turn), and reported usage agrees
            // with what the endpoint actually served.
            expect(phases.filter(phase => phase === "unexpected")).toEqual([]);
            expect(phases.filter(phase => phase === "reset-call").length).toBe(BATCHES - 1);
            expect(server.requests.length).toBe(BATCHES + 2 * (BATCHES - 1));
            expect(result.usage.apiCalls).toBe(server.requests.length);
            expect(result.turnCount).toBe(BATCHES);
        } finally {
            await server.close();
            await rm(root, { recursive: true, force: true });
        }
    });
});
