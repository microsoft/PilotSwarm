import { describe, it, expect } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { createEphemeralSessionRunner } from "../../dist/ephemeral-session.js";
import { createEphemeralClient } from "../../dist/ephemeral-client.js";
import { loadProviderTypes } from "../../src/provider-catalog.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";

const MODEL = "gpt-5.6-terra";

function credentialCatalog(credential) {
    const providers = { async lookupUserId() { return 1; }, async getCredential() { return credential; } };
    return {
        async getUserRole() { return { role: "user", roleSeenAt: null }; },
        providers: new Proxy(providers, { get(target, key) {
            if (key in target) return target[key];
            throw new Error(`unexpected provider call: ${String(key)}`);
        } }),
    };
}

async function fixture(prefix, batches) {
    const root = path.resolve(`.${prefix}-${randomUUID()}`);
    const cwd = path.join(root, "workspace"), scratch = path.join(root, "sdk");
    await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
    const artifact = path.join(cwd, "artifact.txt");
    await writeFile(artifact, "preserved-artifact", { mode: 0o600 });
    const digest = async () => createHash("sha256").update(await readFile(artifact)).digest("hex");
    return {
        root, cwd, scratch, before: await digest(), digest,
        // Canaries are spoken only by the model, never by a prompt, so finding
        // one in a later window proves real conversational carryover.
        canaries: Array.from({ length: batches }, (_v, i) => `CANARY${i}-${randomUUID().slice(0, 8)}`),
        prompts: Array.from({ length: batches }, (_v, i) => `BATCH${i}WORK-${randomUUID().slice(0, 8)}`),
        system: `SYSTEMMARK-${randomUUID().slice(0, 8)}`,
    };
}

const has = (body, text) => JSON.stringify(body).includes(text);

/**
 * Raw `history.clearContext` on CLI 1.0.85 in ephemeral mode, with no barrier,
 * no request interception and no compaction. A separate host-driven turn after
 * the neutral seed observes the rebuilt provider window.
 */
describe("raw ephemeral history.clearContext characterization (CLI 1.0.85)", () => {
    it("rebuilds the window on the next host-driven turn after a neutral seed", { timeout: 180000 }, async () => {
        const batches = 3;
        const f = await fixture("raw-clear-host", batches);
        const SEED = `NEUTRALSEED-${randomUUID().slice(0, 8)}`;
        const sessions = new Set(), events = [], clears = [];
        let session, current = 0, clearedThisTurn = false;

        const server = await createNativeCopilotProvider(body => {
            const last = String(body.messages.at(-1)?.content ?? "");
            // The seed turn still sees the stale window, so answer it the way a
            // real model might: mentioning the batch that just finished.
            if (last.includes(SEED)) return { content: `SEEDACK ${f.canaries[current]}` };
            // A clear is only legal with a tool call in flight; the progress tool
            // is the host-controlled hook that provides one.
            if (last.includes(f.prompts[current])) {
                return { tools: [{ name: "ephemeral_report_progress", args: { stage: "working" } }] };
            }
            return { content: `Finished batch ${current}. ${f.canaries[current]}` };
        });
        const types = loadProviderTypes({ providers: [{
            id: "template", type: "openai", baseUrl: server.baseUrl, models: [MODEL] }] });
        try {
            const run = createEphemeralSessionRunner(credentialCatalog({ name: "synthetic", typeId: "template",
                class: "shared", ownerUserId: null, baseUrl: null, secretRef: { value: "synthetic-only-key" } }),
                () => types, {
                    scratchRoot: f.scratch,
                    createClient: (options, provider) => {
                        const client = createEphemeralClient(options, provider, () => {}, () => {});
                        return { ...client, async createSession(config) {
                            session = await client.createSession({ ...config, onEvent(event) {
                                events.push(event);
                                // Harness-only: the runner interrupts on a clear it
                                // did not itself request. Withholding the event lets
                                // the raw runtime behavior be observed unchanged.
                                if (event.type === "session.context_cleared") return;
                                config.onEvent?.(event);
                            } });
                            sessions.add(session.sessionId);
                            return session;
                        } };
                    },
                });
            const result = await run({
                actor: { provider: "fixture", subject: "test" }, executionId: randomUUID(),
                model: `synthetic:${MODEL}`, workingDirectory: f.cwd,
                systemMessage: f.system, prompt: f.prompts[0], progressStages: ["working"],
                onProgress: async () => {
                    if (clearedThisTurn || current >= batches - 1) return;
                    clearedThisTurn = true;
                    clears.push(await session.rpc.history.clearContext({ prompt: SEED }));
                },
                onResponse: async () => {
                    if (current >= batches - 1) return { action: "complete" };
                    current++; clearedThisTurn = false;
                    return { action: "continue", prompt: f.prompts[current] };
                },
            });

            expect(sessions.size).toBe(1);
            expect(result.turnCount).toBe(batches);
            expect(result.text).toContain(f.canaries[batches - 1]);
            // The clear reports a positive count and raises an observable event
            // carrying the seed it installed alongside the count.
            expect(clears.every(value => Number.isSafeInteger(value.messagesCleared)
                && value.messagesCleared > 0)).toBe(true);
            const cleared = events.filter(event => event.type === "session.context_cleared");
            expect(cleared.length).toBe(batches - 1);
            expect(cleared.every(event => Object.keys(event.data).sort()
                .join() === "initialMessage,messagesCleared")).toBe(true);

            // Window shape per boundary: the seeded turn runs stale, then the
            // next host-driven turn is a genuinely rebuilt window.
            expect(server.requests.map(body => body.messages.length)).toEqual([2, 5, 3, 6, 3, 5]);
            for (const index of [2, 4]) {
                const window = server.requests[index];
                expect(window.messages.map(message => message.role)).toEqual(["system", "assistant", "user"]);
                // The system instruction survives; the seed and every earlier
                // batch prompt do not.
                expect(has(window, f.system)).toBe(true);
                expect(has(window, SEED)).toBe(false);
                const batch = index / 2;
                for (let prior = 0; prior < batch; prior++) expect(has(window, f.prompts[prior])).toBe(false);
                expect(has(window, f.prompts[batch])).toBe(true);
            }
            // The single surviving channel is the seed turn's own assistant
            // reply, which was produced against the stale window: whatever it
            // says crosses the boundary. Here it named the finished batch's
            // canary, and that canary is the only prior content that survives.
            expect(has(server.requests[2], f.canaries[0])).toBe(true);
            expect(server.requests[2].messages[1].role).toBe("assistant");
            expect(String(server.requests[2].messages[1].content)).toContain("SEEDACK");
            expect(has(server.requests[4], f.canaries[0])).toBe(false);

            // Isolation and artifacts are untouched by a clear.
            expect(await f.digest()).toBe(f.before);
        } finally { await server.close(); await rm(f.root, { recursive: true, force: true }); }
    });
});
