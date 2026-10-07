import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import { withSteeringCli, nextSdkEvent, within } from "../helpers/steering-cli.mjs";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { runTurnCommit, runTurnPreamble } from "../../src/session-lifecycle.ts";
import { writeTurnSentinel } from "../../src/snapshot-protocol.ts";
import { barrier, makeSteeringTurnHarness } from "../helpers/steering-turn-harness.mjs";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { createCmsSteeringChannel } from "../../src/steering-channel.ts";
import { withSteeringLedger } from "../helpers/steering-ledger.js";

const TIMEOUT = 60_000;

function recordedSteeringProduct(sdk, ledger) {
    const product = makeSteeringTurnHarness({ sdkSession: sdk });
    const real = createCmsSteeringChannel(ledger.catalog, ledger.sessionId,
        { epoch: ledger.target.epoch, turnIndex: ledger.target.turn, incarnation: ledger.target.incarnation },
        ledger.target.owner, { recoverySource: "restored" });
    Object.assign(product.channel, real);
    for (const [name, value] of Object.entries(real)) {
        if (typeof value === "function") product.channel[name] = vi.fn(value);
    }
    const open = product.channel.openWindow;
    product.channel.openWindow = vi.fn(async () => {
        const result = await open();
        product.accepted = await ledger.accept({ content: "Keep this guidance separate" });
        assertEqual(product.accepted.result.outcome, "accepted");
        return result;
    });
    return product;
}

describe.concurrent("session steering real-CLI enablement gates", () => {
    it("F01/ST-I18 normal-settlement partial gate: quiescence ceases an active owned late run before returning, without Stop", { timeout: 75_000 }, async () => {
        const mainRelease = Promise.withResolvers();
        const issuedRelease = Promise.withResolvers();
        const sendEntered = Promise.withResolvers();
        const lateRequest = Promise.withResolvers();
        const lateRelease = Promise.withResolvers();
        const originalIdle = Promise.withResolvers();
        const sendFinished = Promise.withResolvers();
        let closedGeneration = false;
        const oldRequestsAfterBoundary = [];
        await withSteeringLedger(async ledger => { await withSteeringCli(async (body, _position, record) => {
            const texts = body.messages.filter((message) => message.role === "user")
                .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
            if (texts.some((text) => text.includes("unrelated normal-settlement peer"))) return { content: "peer usable" };
            if (closedGeneration) {
                oldRequestsAfterBoundary.push(record);
                throw new Error("fixture: SDK work began after its normal-settlement generation ceased");
            }
            if (texts.some((text) => text.includes("Keep this guidance separate"))) {
                lateRequest.resolve(record);
                await lateRelease.promise;
                return { content: "late owned answer" };
            }
            await mainRelease.promise;
            return { content: "earlier response" };
        }, async (h) => {
            let manager;
            try {
                const registry = new ModelProviderRegistry({ providers: [{
                    id: "normal-settlement-fixture", type: "openai", baseUrl: h.model.baseUrl, apiKey: "synthetic-key",
                    models: ["fixture-model"],
                }] });
                manager = new SessionManager(undefined, null, { modelProviders: registry }, join(h.home, "session-state"));
                manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
                const id = ledger.sessionId;
                const managed = await manager.getOrCreate(id, { model: "normal-settlement-fixture:fixture-model" }, { turnIndex: 0 });
                const peer = await manager.getOrCreate(randomUUID(), { model: "normal-settlement-fixture:fixture-model" }, { turnIndex: 0 });
                const sdk = managed.copilotSession;
                const abort = vi.spyOn(sdk, "abort");
                const observedSdkEvents = [];
                sdk.on(event => observedSdkEvents.push(event));
                sdk.on("session.idle", () => originalIdle.resolve());
                const actualSend = sdk.send.bind(sdk);
                sdk.send = async (input) => {
                    if (input.mode === "immediate") { sendEntered.resolve(); await issuedRelease.promise; }
                    const returned = await actualSend(input);
                    if (input.mode === "immediate") sendFinished.resolve(returned);
                    return returned;
                };
                const product = recordedSteeringProduct(sdk, ledger);
                let atBoundary = null;
                let abortsBeforeQuiescence = null;
                const quiesce = vi.fn(async () => {
                    abortsBeforeQuiescence = abort.mock.calls.length;
                    const active = await lateRequest.promise;
                    assertEqual(active.connectionClosed, false, "the owned late model request is positively active before quiescence");
                    const result = await manager.quiesceForSteering(id);
                    atBoundary = active.connectionClosed;
                    closedGeneration = true;
                    return result;
                });
                const turn = managed.runTurn("normal-settlement original prompt", {
                    turnIndex: 1, steering: product.channel, steeringQuiesce: quiesce,
                });
                await within(sendEntered.promise, "registered pre-issue send boundary");
                mainRelease.resolve();
                await within(originalIdle.promise, "real main session idle before late SDK invocation");
                issuedRelease.resolve();
                await within(sendFinished.promise, "actual issued late SDK send acknowledgment");
                await within(lateRequest.promise, "actual owned late model HTTP work");
                const result = await within(turn, "normal settlement bounded ownership resolution", 45_000);
                assertEqual(result.type, "completed");
                assertEqual(quiesce.mock.calls.length, 1);
                assertEqual(abortsBeforeQuiescence, 0, "normal settlement proof uses no preceding Stop/abort; quiescence may use its own cessation primitive");
                assertEqual(abort.mock.calls.length, 1, "quiescence issues exactly one isolated funnel abort for the late owned run");
                assertEqual(managed.getActiveTurn(), null);
                assertEqual(manager.get(id), null);
                const receipt = await ledger.catalog.steerGet(id, product.accepted.requestId);
                assertEqual(receipt.attempts.total, 1);
                const storedAttempt = (await ledger.attempts(product.accepted.requestId))[0];
                const deliveredEvent = observedSdkEvents.find(event => event.type === "user.message"
                    && event.data?.messageId === storedAttempt.sdk_message_id);
                assert(deliveredEvent, "positive delivery has the exact correlated SDK user.message, not an acknowledgment");
                assert(["queued", "idle"].includes(deliveredEvent.data.delivery), "delivery follows the naturally ended earlier response");
                assertEqual(receipt.attempts.items[0].deliveryKind, deliveredEvent.data.delivery);
                assertEqual(receipt.inclusion.state, "unconfirmed", "without snapshot publication, local receipt does not invent saved inclusion");
                await ledger.finalize({ manifest: result.steering?.delivered.map(item => item.requestId) });
                assertEqual((await ledger.catalog.steerGet(id, product.accepted.requestId)).disposition, "delivered_after_response");
                lateRelease.resolve();
                const requestsAtBoundary = h.model.sessionRequests().length;
                assertEqual(manager.clients.size, 1);
                assertEqual((await peer.runTurn("unrelated normal-settlement peer", { turnIndex: 1 })).content, "peer usable");
                assertEqual(oldRequestsAfterBoundary.length, 0);
                assertEqual(h.model.sessionRequests().length, requestsAtBoundary + 1);
                assertEqual(atBoundary, true, "positive cessation is sampled at quiescence return, not after unrelated peer work");
            } finally {
                mainRelease.resolve();
                issuedRelease.resolve();
                lateRelease.resolve();
                await manager?.shutdown();
            }
        }); });
    });

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

    for (const steering of [true, false]) it(steering
        ? "ST-I18 fast-Stop: cessation and post-release tripwire preserve the warm handle"
        : "non-steering Stop preserves its existing cessation and reusable-handle contract", { timeout: TIMEOUT }, async () => {
        const modelEntered = Promise.withResolvers();
        const modelRelease = Promise.withResolvers();
        const sendIssued = Promise.withResolvers();
        const sendResponse = Promise.withResolvers();
        const responseContinuation = Promise.withResolvers();
        let generationClosed = false;
        const oldGenerationRequests = [];
        await withSteeringLedger(async ledger => { await withSteeringCli(async (_body, position, record) => {
            if (position.lastUserText.includes("next ordinary turn on the same warm handle")) return { content: "same handle remains usable" };
            if (position.firstUserText.includes("original prompt")) {
                if (generationClosed) {
                    oldGenerationRequests.push(record);
                    throw new Error("fixture: model work started after target-generation quiescence");
                }
                modelEntered.resolve(record);
                await modelRelease.promise;
                return { content: "held main response" };
            }
            return { content: "second session still works" };
        }, async (h) => {
            let product;
            let managed;
            let manager;
            try {
                const registry = new ModelProviderRegistry({ providers: [{
                    id: "steering-fixture", type: "openai", baseUrl: h.model.baseUrl, apiKey: "synthetic-key",
                    models: ["fixture-model"],
                }] });
                manager = new SessionManager(undefined, null, { modelProviders: registry }, join(h.home, "session-state"));
                manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
                const sessionId = ledger.sessionId;
                managed = await manager.getOrCreate(sessionId, { model: "steering-fixture:fixture-model" }, { turnIndex: 0 });
                const other = await manager.getOrCreate(randomUUID(), { model: "steering-fixture:fixture-model" }, { turnIndex: 0 });
                const sdk = managed.copilotSession;
                assertEqual(manager.clients.size, 1, "both sessions use the same actual client pool");
                const actualSend = sdk.send.bind(sdk);
                sdk.send = async (input) => {
                    const id = await actualSend(input);
                    if (input.mode === "immediate") {
                        sendIssued.resolve(id);
                        await sendResponse.promise;
                        responseContinuation.resolve(id);
                    }
                    return id;
                };
                const lateEvents = [];
                sdk.on((event) => lateEvents.push(event));
                product = recordedSteeringProduct(sdk, ledger);
                const disconnect = vi.fn(() => manager.quiesceForSteering(sessionId));
                const turn = managed.runTurn("original prompt", {
                    turnIndex: 1, ...(steering ? { steering: product.channel, steeringQuiesce: disconnect } : {}),
                });
                const request = await within(modelEntered.promise, "active product model request");
                const issuedId = steering ? await within(sendIssued.promise, "actual already-issued immediate RPC") : null;
                assertEqual(request.connectionClosed, false);
                managed.requestStop("Stop delayed-send fixture");
                managed.abort();
                const result = await within(turn, "bounded product Stop/quiescence", 30_000);
                assertEqual(result.type, "stopped");
                assertEqual(managed.getActiveTurn(), null);
                assertEqual(manager.get(sessionId) === managed, true, "fast Stop preserves its successfully ceased warm handle");
                assertEqual(disconnect.mock.calls.length, 0, "Stop does not await steering quiescence");
                assertEqual(request.connectionClosed, true, "actual main model work has ceased before ownership returns");
                const requestsAtReturn = h.model.sessionRequests().length;
                const eventsAtReturn = lateEvents.length;
                const renewalsAtReturn = product.channel.renew.mock.calls.length;
                const handoffsAtReturn = product.channel.markSubmitting.mock.calls.length;
                generationClosed = true;
                sendResponse.resolve();
                modelRelease.resolve();
                if (steering) {
                    assertEqual(await within(responseContinuation.promise, "registered response continuation after Stop"), issuedId);
                    await ledger.catalog.steerCloseStopped(sessionId, 1);
                    const receipt = await ledger.catalog.steerGet(sessionId, product.accepted.requestId);
                    assertEqual(receipt.status, "closed");
                    assertEqual(receipt.closureReason, "stopped");
                    assert(["delivery_unconfirmed", "delivered_before_stop", "delivered_timing_unconfirmed"].includes(receipt.disposition));
                    if (receipt.disposition !== "delivery_unconfirmed") {
                        assert(lateEvents.some(event => event.type === "user.message" && event.data?.messageId === issuedId),
                            "any positive delivery requires correlated SDK history");
                    }
                }
                const answer = await other.runTurn("unrelated second session prompt", { turnIndex: 1 });
                assertEqual(answer.content, "second session still works");
                assertEqual(h.model.sessionRequests().length, requestsAtReturn + 1, "late send response starts no orphan model work");
                assert(!lateEvents.slice(eventsAtReturn).some((event) => event.type === "assistant.message"
                    || event.type === "assistant.turn_start" || event.type === "tool.execution_start"),
                "late events after ownership release do not continue model/tool work");
                assertEqual(oldGenerationRequests.length, 0, "endpoint tripwire saw no old-generation successor request");
                assertEqual(product.channel.renew.mock.calls.length, renewalsAtReturn, "disposed pump never rearms its lease");
                assertEqual(product.channel.markSubmitting.mock.calls.length, handoffsAtReturn, "late continuation cannot authorize another handoff");
                assertEqual(product.copilot.send === sdk.send, true);
                const next = await managed.runTurn("next ordinary turn on the same warm handle", { turnIndex: 2 });
                assertEqual(next.type, "completed");
                assertEqual(next.content, "same handle remains usable");
                assertEqual(manager.get(sessionId) === managed, true);
                assertEqual(manager.clients.size, 1, "the shared client remains in service");
                assertEqual(oldGenerationRequests.length, 0, "intentional next input is allowed; old-generation work remains fenced");
            } finally {
                sendResponse.resolve();
                modelRelease.resolve();
                managed?.requestStop("fixture cleanup");
                managed?.abort();
                await manager?.shutdown();
            }
        }); });
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
