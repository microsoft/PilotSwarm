/**
 * Review L1 (per-session memory on TEST): when the worker lets a session go (eviction, its end, a dehydrate), the session is
 * closed in the Copilot CLI (sessions.close) and the SDK's session object is dropped from CopilotClient.sessions; before,
 * the warm handle was only detached, so every finished session stayed in both processes. The next turn resumes the session
 * with its whole conversation, after each of the three: after eviction and after a dehydrate its local files are gone, so
 * that turn rehydrates it from the session store (the files the close flushed); after its end, from the local files. A real worker and the real Copilot CLI, with a
 * scripted model (no tokens).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 300_000;
const TURN_MS = 120_000;
const OWNER = { provider: "test", subject: "cli-session-close", email: null, displayName: null };
const FIRST = "first turn of the close check";

describe("the Copilot CLI's session is closed when the worker lets it go (review L1)", () => {
    it("eviction, the session's end and a dehydrate close it in the CLI and drop the SDK's object; each next turn resumes it with its conversation", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, { worker: { logLevel: "warning" } }, async ({ client, worker, model, qualifiedModel }) => {
            const manager = worker.sessionManager;
            expect(worker.blobEnabled).toBe(true);
            const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
            const id = chat.sessionId;
            await chat.sendAndWait(FIRST, TURN_MS);
            const copilot = manager.clients.get(manager.sessionClientKeys.get(id));
            expect(copilot).toBeDefined();
            const closes = [];
            const close = copilot.rpc.sessions.close;
            copilot.rpc.sessions.close = async params => { closes.push(params.sessionId); return close(params); };
            /** The conversation the model saw in this conversation's latest turn: its turn number and first prompt. */
            const lastTurn = () => model.sessionRequests(FIRST).at(-1).position;

            const steps = [
                ["eviction", async () => {
                    manager.sessionLastTouchedAt.set(id, Date.now() - 60_000);
                    expect(await manager.sweepIdleSessions(1_000)).toBeGreaterThanOrEqual(1);
                }],
                ["the session's end (destroySession)", async () => manager.destroySession(id)],
                ["a dehydrate", async () => manager.dehydrate(id, "close-check")],
            ];
            for (const [index, [label, letGo]] of steps.entries()) {
                expect(copilot.sessions.has(id), `${label}: the SDK holds the warm session`).toBe(true);
                const before = closes.length;
                await letGo();
                expect(manager.sessions.has(id), label).toBe(false);
                expect(closes.slice(before), label).toEqual([id]);
                expect(copilot.sessions.has(id), `${label}: the SDK's object is dropped`).toBe(false);
                // Eviction and a dehydrate leave no local files: the next turn rehydrates from the store.
                if (label !== "the session's end (destroySession)") {
                    expect(fs.existsSync(path.join(env.sessionStateDir, id)), `${label}: no local files`).toBe(false);
                }
                // The next turn resumes the session from its files, with the whole conversation so far.
                await chat.sendAndWait(`turn ${index + 2} after ${label}`, TURN_MS);
                expect(lastTurn(), label).toMatchObject({ turn: index + 2, firstUserText: expect.stringContaining(FIRST) });
                expect(lastTurn().lastUserText, label).toContain(`turn ${index + 2} after ${label}`);
            }
        });
    });
});
