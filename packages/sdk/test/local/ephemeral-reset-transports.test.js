// Transport matrix for the inter-batch context reset.
//
// The boundary is driven through the runtime's own RPC and never synthesizes
// provider traffic, so it should not care what wire the provider speaks. This
// suite turns that claim into evidence: the same reset assertions run against
// a real scripted endpoint for each provider wire CLI 1.0.85 actually uses.
import { describe, it, expect } from "vitest";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";

import { createEphemeralSessionRunner } from "../../dist/ephemeral-session.js";
import { createEphemeralClient } from "../../dist/ephemeral-client.js";
import { loadProviderTypes } from "../../src/provider-catalog.ts";
import { WIRES, createScriptedWire } from "../helpers/scripted-wires.mjs";

const MODEL = "gpt-5.6-terra";
const SEEDED_REPLY = "Ready for the next instruction.";

function credentialCatalog(credential) {
    return {
        async getUserRole() { return { role: "user", roleSeenAt: null }; },
        providers: { async lookupUserId() { return 1; }, async getCredential() { return credential; } },
    };
}

describe("ephemeral context reset transport matrix", () => {
    for (const [name, wire] of Object.entries(WIRES)) it.concurrent(
        `${name}: a boundary rebuilds the window on this wire`,
        { timeout: 180000 }, async () => {
            const batches = 2;
            const root = path.resolve(`.ephemeral-wire-${name}-${randomUUID()}`);
            const cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
            await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
            const artifact = path.join(cwd, "artifact.txt");
            await writeFile(artifact, "preserved-artifact", { mode: 0o600 });
            const before = createHash("sha256").update(await readFile(artifact)).digest("hex");

            // Spoken only by the model, never by a prompt.
            const canaries = Array.from({ length: batches }, (_v, i) => `CANARY-${i}-${randomUUID().slice(0, 8)}`);
            const prompts = Array.from({ length: batches }, (_v, i) => `BATCH ${i} WORK ${randomUUID().slice(0, 8)}`);
            const phases = [], events = [];

            const server = await createScriptedWire(wire, (messages, tools) => {
                const last = messages.at(-1) ?? {};
                const index = prompts.findIndex(prompt => String(last.content ?? "").includes(prompt));
                if (index >= 0) { phases.push(`batch-${index}`); return { content: `Finished batch ${index}. ${canaries[index]}` }; }
                // The boundary's second request already carries this turn's tool
                // call, which is how it is told apart on every wire alike.
                if (messages.some(message => message.toolCalls > 0)) { phases.push("reset-seeded"); return { content: SEEDED_REPLY }; }
                const tool = tools.find(entry => typeof entry === "string" && entry.includes("context_reset"));
                if (tool) { phases.push("reset-call"); return { tool }; }
                phases.push("unexpected"); return { content: "UNEXPECTED" };
            });

            const types = loadProviderTypes({ providers: [{
                id: "template", type: wire.type, baseUrl: server.baseUrl, models: [MODEL],
                ...(wire.type === "azure" ? { apiVersion: "2024-10-21" } : {}),
            }] });
            const catalog = credentialCatalog({
                name: "synthetic", typeId: "template", class: "shared", ownerUserId: null,
                baseUrl: null, secretRef: { value: "synthetic-only-key" },
            });
            try {
                const run = createEphemeralSessionRunner(catalog, () => types, {
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
                const result = await run({
                    actor: { provider: "fixture", subject: "test" }, executionId: randomUUID(),
                    model: `synthetic:${MODEL}`, workingDirectory: cwd,
                    systemMessage: "Private synthetic system", prompt: prompts[0], contextReset: true,
                    onResponse: async value => { responses.push(value.text); turn++;
                        return turn < batches ? { action: "clear_context", prompt: prompts[turn] } : { action: "complete" }; },
                });

                // The wire was actually exercised in its own shape.
                expect(server.requests.length).toBeGreaterThan(0);
                expect(phases.filter(phase => phase === "unexpected")).toEqual([]);
                if (wire.streams) expect(server.streamed()).toBeGreaterThan(0);

                expect(result.text).toContain(canaries[batches - 1]);
                expect(result.turnCount).toBe(batches);
                expect(responses.length).toBe(batches);
                expect(responses.some(text => text.includes(SEEDED_REPLY))).toBe(false);

                // The first real post-reset request carries no prior batch.
                const real = server.requests.filter(body =>
                    prompts.some(prompt => JSON.stringify(wire.messages(body).at(-1) ?? {}).includes(prompt)));
                expect(real.length).toBe(batches);
                const window = JSON.stringify(wire.messages(real[1]));
                expect(window).not.toContain(canaries[0]);
                expect(window).not.toContain(prompts[0]);
                // The one documented residue, and nothing else.
                expect(wire.messages(real[1]).filter(message => message.role === "assistant")
                    .map(message => message.content)).toEqual([SEEDED_REPLY]);
                // The system instruction survives the boundary on every wire.
                expect(JSON.stringify(wire.messages(real[1]))).toContain("Private synthetic system");

                // The clear is observed from the runtime, not inferred from text.
                const cleared = events.filter(event => event.type === "session.context_cleared");
                expect(cleared.length).toBe(batches - 1);
                expect(cleared.every(event => Number.isSafeInteger(event.data.messagesCleared)
                    && event.data.messagesCleared > 0)).toBe(true);

                // Usage matches what this endpoint actually served.
                expect(result.usage.apiCalls).toBe(server.requests.length);
                expect(createHash("sha256").update(await readFile(artifact)).digest("hex")).toBe(before);
                // eslint-disable-next-line no-console
                console.log(`  wire ${name} (${wire.type}): phases=${phases.join(" -> ")}`,
                    `requests=${server.requests.length} streamed=${server.streamed()}`,
                    `paths=${JSON.stringify([...new Set(server.paths)])}`);
            } finally {
                await server.close();
                await rm(root, { recursive: true, force: true });
            }
        });
});
