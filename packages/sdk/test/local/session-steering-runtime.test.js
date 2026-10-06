import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import { withSteeringCli, nextSdkEvent, within } from "../helpers/steering-cli.mjs";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { runTurnCommit, runTurnPreamble } from "../../src/session-lifecycle.ts";
import { writeTurnSentinel } from "../../src/snapshot-protocol.ts";
import { barrier, makeSteeringTurnHarness } from "../helpers/steering-turn-harness.mjs";

const TIMEOUT = 60_000;

describe.concurrent("session steering real-CLI enablement gates", () => {
    it("ST-I07: a registered send arriving after the first idle stays owned until its own idle", { timeout: TIMEOUT }, async () => {
        const mainRequest = Promise.withResolvers();
        const mainRelease = Promise.withResolvers();
        const rpc = barrier();
        await withSteeringCli(async (_body, position) => {
            if (position.lastUserText.includes("original prompt")) {
                mainRequest.resolve();
                await mainRelease.promise;
                return { content: "earlier response" };
            }
            return { content: "late steering response" };
        }, async (h) => {
            try {
                const sdk = await h.client.createSession(h.config);
                const send = sdk.send.bind(sdk);
                sdk.send = async (input) => {
                    if (input.mode === "immediate") await rpc.hold();
                    return await send(input);
                };
                const product = makeSteeringTurnHarness({ sdkSession: sdk });
                let settled = false;
                const turn = product.run().then((result) => { settled = true; return result; });
                await within(mainRequest.promise, "main model request");
                await within(rpc.entered, "registered product steering send");
                const firstIdle = nextSdkEvent(sdk, "session.idle");
                mainRelease.resolve();
                await within(firstIdle.promise, "first SDK idle");
                assertEqual(settled, false, "unresolved registered send still belongs to the turn");
                rpc.release();
                const result = await within(turn, "owned late-run settlement", 30_000);
                assertEqual(result.type, "completed");
                assertEqual(product.channel.markDelivered.mock.calls.length, 1);
                assertEqual(product.channel.markDelivered.mock.calls[0][2], "idle");
                assertEqual(result.steering.delivered.length, 1);
                assertEqual(result.steering.delivered[0].kind, "idle");
                assertEqual(product.managed.getActiveTurn(), null);
                assertEqual(h.model.sessionRequests().length, 2, "the second SDK run is owned, not another PilotSwarm turn");
            } finally {
                mainRelease.resolve();
                rpc.release();
            }
        });
    });

    it("ST-I08: real CLI abort-before-claim-release never invokes immediate send", { timeout: TIMEOUT }, async () => {
        const mainRelease = Promise.withResolvers();
        await withSteeringCli(async () => {
            await mainRelease.promise;
            return { content: "main response" };
        }, async (h) => {
            const sdk = await h.client.createSession(h.config);
            const sends = vi.spyOn(sdk, "send");
            const product = makeSteeringTurnHarness({ sdkSession: sdk, block: "claim" });
            const turn = product.run();
            try {
                await within(product.cut.entered, "claimed-row barrier");
                product.managed.requestStop("fixture Stop");
                product.managed.abort();
                product.cut.release([product.row]);
                const result = await within(turn, "stopped product turn", 30_000);
                assertEqual(result.type, "stopped");
                assertEqual(sends.mock.calls.filter(([input]) => input.mode === "immediate").length, 0);
                assertEqual(product.channel.markSubmitting.mock.calls.length, 0, "Stop wins before write-ahead authorization");
            } finally {
                product.cut.release([]);
                mainRelease.resolve();
                sends.mockRestore();
            }
        });
    });

    it("ST-I18 prerequisite: disconnect must cease a held model run without stopping a second session", { timeout: TIMEOUT }, async () => {
        const mainRequest = Promise.withResolvers();
        const modelRelease = Promise.withResolvers();
        const sendRelease = Promise.withResolvers();
        await withSteeringCli(async (_body, position, record) => {
            if (position.firstUserText.includes("held main turn") && position.step === 0) {
                mainRequest.resolve(record);
                await modelRelease.promise;
                return { content: "held turn finished" };
            }
            return { content: "unrelated session remains usable" };
        }, async (h) => {
            try {
                const main = await h.client.createSession(h.config);
                const other = await h.client.createSession(h.config);
                const originalSend = main.send.bind(main);
                await within(originalSend({ prompt: "held main turn" }), "main send RPC");
                const request = await within(mainRequest.promise, "main model request");
                // The SDK RPC is issued now; only its response is withheld from the owner.
                const issued = originalSend({ prompt: "late registered steer", mode: "immediate" });
                const registered = issued.then(async (id) => { await sendRelease.promise; return id; });
                const sdkMessageId = await within(issued, "steering send RPC");
                assertEqual(request.connectionClosed, false, "the held model request is active immediately before disconnect");
                await within(main.disconnect(), "per-session disconnect");
                const otherReply = await other.sendAndWait({ prompt: "unrelated main turn" }, 20_000);
                assertEqual(otherReply.data.content, "unrelated session remains usable");
                const ceasedAtDisconnect = request.connectionClosed;
                sendRelease.resolve();
                modelRelease.resolve();
                assertEqual(await registered, sdkMessageId, "late response remains attributable to its registered send");
                assert(ceasedAtDisconnect,
                    "ENABLEMENT BLOCKER: per-session disconnect acknowledged while the owning model HTTP request remained active; acknowledgment is not cessation");
            } finally {
                sendRelease.resolve();
                modelRelease.resolve();
            }
        });
    });

    it("ST-I12 prerequisite: getEvents after PilotSwarm preamble reflects the restored snapshot, not dirty warm memory", { timeout: TIMEOUT }, async () => {
        await withSteeringCli(() => ({ content: "fixture answer" }), async (h) => {
            let session = await h.client.createSession(h.config);
            const sessionId = session.sessionId;
            const sessionStateDir = join(h.home, "session-state");
            const sessionDir = join(sessionStateDir, sessionId);
            const store = new FilesystemSessionStore(join(h.home, "stored-snapshots"), sessionStateDir);
            const lifecycle = {
                store, sessionStateDir, sessionId, expectedVersion: 0, turnKey: "snapshot-fixture-base",
                dropWarmSession: async () => { await session.disconnect(); },
                trace() {},
            };
            await runTurnPreamble(lifecycle);
            const savedIdle = nextSdkEvent(session, "session.idle");
            const savedId = await session.send({ prompt: "committed guidance", mode: "immediate" });
            await savedIdle.promise;
            writeTurnSentinel(sessionDir, lifecycle.turnKey);
            const result = {
                type: "completed", content: "fixture answer",
                steering: { delivered: [{ requestId: "saved-request", attemptId: "saved-attempt", sdkMessageId: savedId, kind: "idle" }] },
            };
            const committed = await runTurnCommit(lifecycle, 0, result);
            assertEqual(committed.published, true, "fixture has a real committed snapshot");

            const dirtyIdle = nextSdkEvent(session, "session.idle");
            const dirtyId = await session.send({ prompt: "unpublished dirty guidance", mode: "immediate" });
            await dirtyIdle.promise;
            const dirtyHistory = await session.getEvents();
            assert(dirtyHistory.some((event) => event.type === "user.message" && event.data.messageId === dirtyId));
            // A surviving local CLI must not become the oracle after a worker loss.
            await h.restart();
            writeTurnSentinel(sessionDir, "snapshot-fixture-retry");
            const pre = await runTurnPreamble({ ...lifecycle, expectedVersion: committed.version, turnKey: "snapshot-fixture-retry",
                dropWarmSession: async () => {} });
            assertEqual(pre.kind, "hydrated", "dirty sentinel forces actual stored-state hydration");
            session = await h.client.resumeSession(sessionId, h.config);
            const restored = await session.getEvents();
            assert(restored.some((event) => event.type === "user.message" && event.data.messageId === savedId), "committed ID is present");
            assert(!restored.some((event) => event.type === "user.message" && event.data.messageId === dirtyId), "discarded warm ID is absent");
            assertEqual(restored.filter((event) => event.type === "user.message" && event.data.messageId === savedId).length, 1);
            console.log("  real CLI restore: committed ID present; dirty ID absent");
        });
    });

    it("ST-I12 prerequisite: cancelled publication remains valid saved inclusion evidence", { timeout: TIMEOUT }, async () => {
        await withSteeringCli(() => ({ content: "cancelled fixture answer" }), async (h) => {
            let session = await h.client.createSession(h.config);
            const sessionId = session.sessionId;
            const sessionStateDir = join(h.home, "session-state");
            const sessionDir = join(sessionStateDir, sessionId);
            const store = new FilesystemSessionStore(join(h.home, "stored-snapshots"), sessionStateDir);
            const lifecycle = {
                store, sessionStateDir, sessionId, expectedVersion: 0, turnKey: "cancelled-published-turn",
                dropWarmSession: async () => {}, trace() {},
            };
            await runTurnPreamble(lifecycle);
            writeTurnSentinel(sessionDir, lifecycle.turnKey);
            const idle = nextSdkEvent(session, "session.idle");
            const sdkMessageId = await session.send({ prompt: "cancelled but published guidance", mode: "immediate" });
            await idle.promise;
            const result = { type: "cancelled", steering: { delivered: [{
                requestId: "cancelled-request", attemptId: "cancelled-attempt", sdkMessageId, kind: "idle",
            }] } };
            const committed = await runTurnCommit(lifecycle, 0, result);
            assertEqual(committed.published, true, "cancelled does not mean unpublished");
            await h.restart();
            const pre = await runTurnPreamble(lifecycle);
            assertEqual(pre.kind, "already-committed");
            assertEqual(pre.result.type, "cancelled");
            expect(pre.result.steering).toEqual(result.steering);
            session = await h.client.resumeSession(sessionId, h.config);
            const restored = await session.getEvents();
            assert(restored.some((event) => event.type === "user.message" && event.data.messageId === sdkMessageId));
        });
    });

    it("ST-I12 prerequisite: stopped delivery is historical but absent from the restored saved base", { timeout: TIMEOUT }, async () => {
        const heldRequest = Promise.withResolvers();
        const release = Promise.withResolvers();
        await withSteeringCli(async (_body, position) => {
            if (position.lastUserText.includes("dirty guidance before Stop")) {
                heldRequest.resolve();
                await release.promise;
                return { content: "dirty reply" };
            }
            return { content: "saved base reply" };
        }, async (h) => {
            try {
                let session = await h.client.createSession(h.config);
                const sessionId = session.sessionId;
                const sessionStateDir = join(h.home, "session-state");
                const sessionDir = join(sessionStateDir, sessionId);
                const store = new FilesystemSessionStore(join(h.home, "stored-snapshots"), sessionStateDir);
                const lifecycle = {
                    store, sessionStateDir, sessionId, expectedVersion: 0, turnKey: "saved-base-turn",
                    dropWarmSession: async () => {}, trace() {},
                };
                await runTurnPreamble(lifecycle);
                await session.sendAndWait({ prompt: "committed seed" }, 20_000);
                writeTurnSentinel(sessionDir, lifecycle.turnKey);
                const base = await runTurnCommit(lifecycle, 0, { type: "completed", content: "saved base reply" });
                assertEqual(base.published, true);
                const stoppedLifecycle = { ...lifecycle, expectedVersion: base.version, turnKey: "stopped-unpublished-turn" };
                await runTurnPreamble(stoppedLifecycle);
                writeTurnSentinel(sessionDir, stoppedLifecycle.turnKey);
                const sdkMessageId = await session.send({ prompt: "dirty guidance before Stop", mode: "immediate" });
                await within(heldRequest.promise, "held stopped model request");
                const historical = await session.getEvents();
                assert(historical.some((event) => event.type === "user.message" && event.data.messageId === sdkMessageId));
                await session.abort();
                const stopped = await runTurnCommit(stoppedLifecycle, base.version, { type: "stopped", reason: "fixture Stop" });
                assertEqual(stopped.published, false);
                assertEqual((await store.probeSnapshot(sessionId)).version, base.version);
                await h.restart();
                const pre = await runTurnPreamble(stoppedLifecycle);
                assertEqual(pre.kind, "hydrated", "dirty stopped state is not a stored winner");
                session = await h.client.resumeSession(sessionId, h.config);
                const restored = await session.getEvents();
                assert(!restored.some((event) => event.type === "user.message" && event.data.messageId === sdkMessageId),
                    "observed delivery alone cannot establish saved inclusion");
            } finally {
                release.resolve();
            }
        });
    });
});
