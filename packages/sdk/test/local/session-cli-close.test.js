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
                expect([...manager.cliClosesOwed.get(id)], "the close is owed").toEqual([key]);
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

    // Review DRR-4: a credential, transport or workspace-root change moves the session to another client. The previous
    // client's session is closed in its CLI and dropped from its SDK map at that rebind (files kept); before, only the new
    // client was ever closed. The previous client is a stand-in (its own CLI is not started); the new one is the worker's.
    it("DRR-4: a rebind closes the session on the previous client; after its release neither client keeps it", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, { worker: { logLevel: "warning" } }, async ({ client, worker, model, qualifiedModel }) => {
            const manager = worker.sessionManager;
            const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
            const id = chat.sessionId;
            await chat.sendAndWait(FIRST, TURN_MS);
            const currentKey = manager.sessionClientKeys.get(id);
            const current = manager.clients.get(currentKey);
            const previousKey = "drr4-previous-client";
            const previousCloses = [];
            const previous = {
                sessions: new Map([[id, { sessionId: id }]]),
                rpc: { sessions: { close: async params => { previousCloses.push(params.sessionId); } } },
                stop: async () => [], forceStop: async () => {},
            };
            const lastTurn = () => model.sessionRequests(FIRST).at(-1).position;
            manager.clients.set(previousKey, previous);
            try {
                // The previous client served the session's last turn; the next turn binds it to the worker's client again.
                manager.sessionClientKeys.set(id, previousKey);
                await chat.sendAndWait("turn 2 on another client", TURN_MS);
                expect(lastTurn()).toMatchObject({ turn: 2, firstUserText: expect.stringContaining(FIRST) });
                expect(manager.sessionClientKeys.get(id)).toBe(currentKey);
                expect(previousCloses, "the rebind closed it on the previous client").toEqual([id]);
                expect(previous.sessions.has(id), "and dropped the previous SDK's object").toBe(false);
                // Its release closes it on the current client; nothing is owed and neither client keeps it.
                manager.sessionLastTouchedAt.set(id, Date.now() - 60_000);
                expect(await manager.sweepIdleSessions(1_000)).toBeGreaterThanOrEqual(1);
                expect(current.sessions.has(id)).toBe(false);
                expect(previous.sessions.has(id)).toBe(false);
                expect(previousCloses).toEqual([id]);
                expect(manager.cliClosesOwed?.has(id) ?? false).toBe(false);
            } finally {
                manager.clients.delete(previousKey);
            }
        });
    });

    // Review DS2-003: the closes a session owes are kept per client: a later failed close never overwrites an earlier one.
    // (A rebind no longer leaves a client with an unconfirmed close, DR2-004; an eviction's or an end's close still can.) A
    // session warm on the worker's client, whose closes on two other clients fail, owes both; the next sweep closes both and
    // leaves the current client's session.
    it("DS2-003: failed closes on two clients are both owed, and the next sweep closes both", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, { worker: { logLevel: "warning" } }, async ({ client, worker, model, qualifiedModel }) => {
            const manager = worker.sessionManager;
            const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
            const id = chat.sessionId;
            await chat.sendAndWait(FIRST, TURN_MS);
            const currentKey = manager.sessionClientKeys.get(id);
            /** A stand-in for another client that holds the session: its first close fails, later ones close. */
            const otherClient = () => {
                const stand = { closes: 0, sessions: new Map([[id, { sessionId: id }]]), stop: async () => [], forceStop: async () => {} };
                stand.rpc = { sessions: { close: async () => {
                    stand.closes += 1;
                    if (stand.closes === 1) throw new Error("the CLI refused the close");
                } } };
                return stand;
            };
            const a = otherClient();
            const b = otherClient();
            manager.clients.set("ds2-003-a", a);
            manager.clients.set("ds2-003-b", b);
            const owed = () => [...(manager.cliClosesOwed?.get(id) ?? [])].sort();
            try {
                await manager.withRunTurnLock(id, "ds2-003", async () => {
                    expect(await manager._closeCliSession(id, "ds2-003-a")).toBe(false);
                    expect(await manager._closeCliSession(id, "ds2-003-b")).toBe(false);
                });
                expect([a.closes, b.closes]).toEqual([1, 1]);
                expect(owed()).toEqual(["ds2-003-a", "ds2-003-b"]);
                // A sweep (nothing is idle) closes it on both A and B; the current client keeps the warm session.
                await manager.sweepIdleSessions(60 * 60 * 1000);
                expect([a.closes, b.closes]).toEqual([2, 2]);
                expect(a.sessions.has(id)).toBe(false);
                expect(b.sessions.has(id)).toBe(false);
                expect(owed()).toEqual([]);
                expect(manager.sessions.has(id)).toBe(true);
                expect(manager.sessionClientKeys.get(id)).toBe(currentKey);
                await chat.sendAndWait("turn 2 on the current client", TURN_MS);
                expect(model.sessionRequests(FIRST).at(-1).position).toMatchObject({ turn: 2, firstUserText: expect.stringContaining(FIRST) });
            } finally {
                manager.clients.delete("ds2-003-a");
                manager.clients.delete("ds2-003-b");
            }
        });
    });

    // Review DR2-004: a rebind moves the binding, and the new client resumes the session, only once the close on the client
    // it leaves is confirmed. A close held past its own deadline but settling within the settle time: the new client waits,
    // then resumes. A close that does not settle: the turn fails with the old binding and the owed close kept, nothing
    // resumes on the new client; once the close lands, the retried turn closes, then resumes there.
    it("DR2-004: a rebind waits for the close on the client it leaves; a close that does not settle fails the turn, and the retry resumes after it", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, { worker: { logLevel: "warning" } }, async ({ client, worker, model, qualifiedModel }) => {
            const manager = worker.sessionManager;
            const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
            const id = chat.sessionId;
            await chat.sendAndWait(FIRST, TURN_MS);
            const currentKey = manager.sessionClientKeys.get(id);
            const current = manager.clients.get(currentKey);
            const resume = current.resumeSession;
            const order = [];
            let gate = null;
            const previous = { sessions: new Map([[id, { sessionId: id }]]), stop: async () => [], forceStop: async () => {},
                rpc: { sessions: { close: async () => {
                    if (gate) await gate.promise;
                    order.push("closed A");
                } } } };
            const hold = () => {
                let release;
                gate = { promise: new Promise(resolve => { release = resolve; }) };
                return () => { const held = gate; gate = null; release(); return held; };
            };
            current.resumeSession = async (...args) => { order.push("resume B"); return resume.apply(current, args); };
            manager.clients.set("dr2-004-a", previous);
            manager.cliCloseTimeoutMs = 300;
            const lastTurn = () => model.sessionRequests(FIRST).at(-1).position;
            try {
                // 1. A's close is held past its deadline (300 ms), and settles within the settle time.
                manager.cliCloseSettleMs = 20_000;
                manager.sessionClientKeys.set(id, "dr2-004-a");
                let release = hold();
                const turn2 = chat.sendAndWait("turn 2 after leaving A", TURN_MS);
                await new Promise(resolve => setTimeout(resolve, 2_000));
                expect(order, "B does not resume while A's close is held").toEqual([]);
                release();
                await turn2;
                expect(order).toEqual(["closed A", "resume B"]);
                expect(manager.sessionClientKeys.get(id)).toBe(currentKey);
                expect(lastTurn()).toMatchObject({ turn: 2, firstUserText: expect.stringContaining(FIRST) });

                // 2. A's close does not settle within the settle time (1 s): the turn fails, keeping A's binding and owed close.
                order.length = 0;
                previous.sessions.set(id, { sessionId: id });
                manager.cliCloseSettleMs = 1_000;
                manager.sessionClientKeys.set(id, "dr2-004-a");
                release = hold();
                const turn3 = chat.sendAndWait("turn 3 after leaving A again", TURN_MS);
                await new Promise(resolve => setTimeout(resolve, 5_000));
                expect(order, "nothing resumes on B").toEqual([]);
                expect(manager.sessionClientKeys.get(id)).toBe("dr2-004-a");
                expect([...(manager.cliClosesOwed.get(id) ?? [])]).toEqual(["dr2-004-a"]);
                // Once the close lands, the retried turn closes A first, then resumes on B.
                release();
                await turn3;
                expect(order.indexOf("closed A")).toBeGreaterThanOrEqual(0);
                expect(order.indexOf("closed A")).toBeLessThan(order.indexOf("resume B"));
                expect(manager.sessionClientKeys.get(id)).toBe(currentKey);
                expect(lastTurn()).toMatchObject({ turn: 3, firstUserText: expect.stringContaining(FIRST) });
            } finally {
                if (gate) gate = null;
                current.resumeSession = resume;
                manager.clients.delete("dr2-004-a");
            }
        });
    });
});
