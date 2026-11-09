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

    // Review DRR-3: a close that fails, or has no answer within its deadline, is not a completed eviction. The session keeps
    // its binding, its files and its idle time, is owed and is not counted; the next sweep closes it. A close still in
    // flight is a barrier: the session's next turn waits for it before it resumes the session.
    it("DRR-3: a failed close is owed: the session keeps its binding and files and is not counted; the next sweep closes and evicts it", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, { worker: { logLevel: "warning" } }, async ({ client, worker, model, qualifiedModel }) => {
            const manager = worker.sessionManager;
            const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
            const id = chat.sessionId;
            const dir = path.join(env.sessionStateDir, id);
            await chat.sendAndWait(FIRST, TURN_MS);
            const key = manager.sessionClientKeys.get(id);
            const copilot = manager.clients.get(key);
            const close = copilot.rpc.sessions.close;
            const resume = copilot.resumeSession;
            const lastTurn = () => model.sessionRequests(FIRST).at(-1).position;
            try {
                // 1. The close fails once.
                const closes = [];
                let failures = 1;
                copilot.rpc.sessions.close = async params => {
                    closes.push(params.sessionId);
                    if (failures-- > 0) throw new Error("the CLI refused the close");
                    return close.call(copilot.rpc.sessions, params);
                };
                manager.sessionLastTouchedAt.set(id, Date.now() - 60_000);
                await manager.sweepIdleSessions(1_000);
                expect(closes).toEqual([id]);
                expect(manager.sessionClientKeys.get(id), "the binding stays").toBe(key);
                expect(manager.cliClosesOwed.get(id), "the close is owed").toBe(key);
                expect(manager.sessionLastTouchedAt.has(id), "it stays an eviction candidate").toBe(true);
                expect(fs.existsSync(dir), "its files stay").toBe(true);
                expect(copilot.sessions.has(id), "the SDK's object stays while the CLI holds the session").toBe(true);
                // The next sweep closes it and evicts it.
                expect(await manager.sweepIdleSessions(1_000)).toBeGreaterThanOrEqual(1);
                expect(closes.length).toBeGreaterThanOrEqual(2);
                expect(manager.cliClosesOwed.has(id)).toBe(false);
                expect(manager.sessionClientKeys.has(id)).toBe(false);
                expect(copilot.sessions.has(id)).toBe(false);
                expect(fs.existsSync(dir)).toBe(false);
                await chat.sendAndWait("turn 2 after an owed close", TURN_MS);
                expect(lastTurn()).toMatchObject({ turn: 2, firstUserText: expect.stringContaining(FIRST) });

            } finally {
                copilot.rpc.sessions.close = close;
                copilot.resumeSession = resume;
            }
        });
    });

    it("DRR-3: a close still in flight past its deadline holds the session's next turn: the turn resumes it only after the close settles", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, { worker: { logLevel: "warning" } }, async ({ client, worker, model, qualifiedModel }) => {
            const manager = worker.sessionManager;
            const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
            const id = chat.sessionId;
            const dir = path.join(env.sessionStateDir, id);
            await chat.sendAndWait(FIRST, TURN_MS);
            const copilot = manager.clients.get(manager.sessionClientKeys.get(id));
            const close = copilot.rpc.sessions.close;
            const resume = copilot.resumeSession;
            const lastTurn = () => model.sessionRequests(FIRST).at(-1).position;
            try {
                manager.cliCloseTimeoutMs = 300;
                let release;
                const gate = new Promise(resolve => { release = resolve; });
                const order = [];
                copilot.rpc.sessions.close = async params => {
                    await gate;
                    await close.call(copilot.rpc.sessions, params);
                    order.push("closed");
                };
                copilot.resumeSession = async (...args) => {
                    order.push("resume");
                    return resume.apply(copilot, args);
                };
                manager.sessionLastTouchedAt.set(id, Date.now() - 60_000);
                await manager.sweepIdleSessions(1_000);
                const kept = { files: fs.existsSync(dir), owed: manager.cliClosesOwed?.has(id) ?? false };
                const turn = chat.sendAndWait("turn 2 after a held close", TURN_MS);
                await new Promise(resolve => setTimeout(resolve, 3_000));
                expect(order, "the turn waits for the close").toEqual([]);
                release();
                await turn;
                expect(order.slice(0, 2)).toEqual(["closed", "resume"]);
                expect(lastTurn()).toMatchObject({ turn: 2, firstUserText: expect.stringContaining(FIRST) });
                // The eviction whose close was not confirmed kept the files, and owed the close.
                expect(kept).toEqual({ files: true, owed: true });
            } finally {
                copilot.rpc.sessions.close = close;
                copilot.resumeSession = resume;
            }
        });
    });
});
