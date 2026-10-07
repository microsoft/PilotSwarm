import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createManagementClient, defineTool } from "../helpers/local-workers.js";
import { setClusterFeature, withScriptedModel } from "../helpers/scripted-workers.js";
import { messageText } from "../helpers/scripted-model.mjs";
import { assignSteeringTestOwner, STEER_AUTHOR } from "../helpers/steering-ledger.js";
import { barrier } from "../helpers/steering-turn-harness.mjs";
import { within } from "../helpers/steering-cli.mjs";

const TIMEOUT = 120_000;
const EDGE = {
    sender: { kind: "user", provider: STEER_AUTHOR.provider, subject: STEER_AUTHOR.subject, display: "Author" },
    authzEnforced: true,
};

/** Wake only on completed real ledger writes; tests never synchronize by sleeping. */
function changes() {
    const listeners = new Set();
    return {
        publish() { for (const listener of [...listeners]) listener(); },
        async until(read, label) {
            const result = Promise.withResolvers();
            let reading = false;
            let again = false;
            const check = async () => {
                if (reading) { again = true; return; }
                reading = true;
                try {
                    do {
                        again = false;
                        const value = await read();
                        if (value) { result.resolve(value); return; }
                    } while (again);
                } catch (error) { result.reject(error); }
                finally { reading = false; }
            };
            listeners.add(check);
            void check();
            try { return await within(result.promise, label, 30_000); }
            finally { listeners.delete(check); }
        },
    };
}

async function fixture(label, { mode = "model", pending = false } = {}, run) {
    const env = createTestEnv(`stop-matrix-${label}`);
    const signal = changes();
    let modelCut = barrier();
    let followCut = barrier();
    let toolCut = barrier();
    let claimCut = barrier();
    const stopCut = barrier();
    const stopReturnCut = barrier();
    const requestsAfterStop = [];
    const toolsAfterStop = [];
    let generation = 0;
    let stoppedGeneration = -1;
    let blockClaims = pending;
    let holdStop = false;
    let holdStopReturn = false;
    let targetSessionId;
    const work = (n) => `matrix-work-${label}-${n}`;
    const tool = defineTool("matrix_held_tool", {
        description: "An explicitly held Stop-matrix tool boundary.",
        parameters: { type: "object", properties: { generation: { type: "number" } }, required: ["generation"] },
        handler: async ({ generation: n }) => {
            if (n <= stoppedGeneration) toolsAfterStop.push(n);
            await toolCut.hold(n);
            return `matrix-tool-finished-${n}`;
        },
    });
    const respond = async (body, position, record) => {
        if (position.lastUserText.includes("matrix-baseline")) return { content: "baseline saved" };
        if (position.lastUserText.includes("matrix-convergence")) return { content: "session usable after Stop" };
        const openingPrompt = body.messages.filter((message) => message.role === "user")
            .map(messageText).filter((text) => text.includes(`matrix-work-${label}-`)).at(-1);
        const n = Number(new RegExp(`matrix-work-${label}-(\\d+)`).exec(openingPrompt ?? "")?.[1]);
        assert(Number.isInteger(n) && n > 0, "actual model request has a synthetic generation identity");
        if (n <= stoppedGeneration) {
            requestsAfterStop.push(record);
            throw new Error("fixture: target model work began after its Stop fence");
        }
        const steered = body.messages.some((message) => message.role === "user"
            && messageText(message).includes(`matrix-guidance-${label}-${n}`));
        if (mode === "tool") {
            const finished = body.messages.some((message) => message.role === "tool"
                && messageText(message).includes(`matrix-tool-finished-${n}`));
            if (!finished) return { tools: [{ name: "matrix_held_tool", args: { generation: n } }] };
            await followCut.hold(record);
            return { content: `current steered answer ${n}` };
        }
        if (steered) {
            await followCut.hold(record);
            return { content: `queued follow-up answer ${n}` };
        }
        await modelCut.hold(record);
        return { content: `earlier response ${n}` };
    };
    try {
        await setClusterFeature(env, "sessions.steering", true, { allowUserOverride: false });
        await withScriptedModel(env, { respond, tools: [tool] }, async ({ client, worker, qualifiedModel, model }) => {
            const catalog = await createCatalog(env);
            const mgmt = await createManagementClient(env);
            const workerCatalog = worker._catalog;
            const manager = worker.sessionManager;
            const restorers = [];
            const patch = (object, name, replace) => {
                const original = object[name];
                object[name] = replace(original);
                restorers.push(() => { object[name] = original; });
            };
            let session;
            let running = false;
            let latestTarget;
            const accepted = [];
            for (const name of [
                "steerWindowOpen", "steerMarkSubmitting", "steerMarkSubmitted", "steerMarkDelivered",
                "steerMarkReleased", "steerMarkUnconfirmed", "steerTurnFinalize", "steerCloseStopped", "recordEvents",
            ]) {
                patch(workerCatalog, name, (original) => async function (...args) {
                    const value = await original.apply(this, args);
                    signal.publish();
                    return value;
                });
            }
            patch(workerCatalog, "steerClaim", (original) => async function (...args) {
                if (args[0] === targetSessionId && generation > 0 && blockClaims) await claimCut.hold(args);
                const value = await original.apply(this, args);
                signal.publish();
                return value;
            });
            patch(manager, "abortWarmSessionTurn", (original) => async function (...args) {
                if (args[0] === targetSessionId && holdStop) await stopCut.hold(args);
                const result = await original.apply(this, args);
                if (args[0] === targetSessionId && holdStopReturn) await stopReturnCut.hold(result);
                return result;
            });
            try {
                session = await client.createSession({ model: qualifiedModel, tools: [tool] });
                targetSessionId = session.sessionId;
                await assignSteeringTestOwner(env, session.sessionId);
                assertEqual(await session.sendAndWait(`matrix-baseline-${label}`, 30_000), "baseline saved");
                const base = await manager.sessionStore.probeSnapshot(session.sessionId);
                assertEqual(base.version, 1);
                let managed = manager.get(session.sessionId);
                const attachStopFence = () => {
                    managed = manager.get(session.sessionId);
                    patch(managed, "requestStop", (original) => function (...args) {
                        const result = original.apply(this, args);
                        if (result) {
                            stoppedGeneration = generation;
                            signal.publish();
                        }
                        return result;
                    });
                };
                attachStopFence();
                const state = () => catalog.steerState(session.sessionId);
                const receipt = (id) => catalog.steerGet(session.sessionId, id);
                const ledger = () => catalog.getSessionEvents(session.sessionId, undefined, 1_000);
                const waitReceipt = (id, predicate, text) => signal.until(async () => {
                    const value = await receipt(id);
                    return value && predicate(value) ? value : null;
                }, text);
                const start = async () => {
                    if (generation > 0) {
                        modelCut = barrier();
                        followCut = barrier();
                        toolCut = barrier();
                        claimCut = barrier();
                    }
                    generation++;
                    running = true;
                    await session.send(work(generation));
                    const opened = await signal.until(async () => {
                        const value = await state();
                        return value.steerable && value.expectedTarget !== latestTarget ? value : null;
                    }, "real running steering window");
                    latestTarget = opened.expectedTarget;
                    await within(mode === "tool" ? toolCut.entered : modelCut.entered,
                        "already-running real model/tool work before the tested Stop cut", 30_000);
                    return latestTarget;
                };
                const accept = async (target = latestTarget, suffix = accepted.length) => {
                    const options = {
                        text: `matrix-guidance-${label}-${generation}-${suffix}`,
                        clientRequestId: randomUUID(), expectedTarget: target,
                    };
                    const result = await mgmt.steerSessionTurn(session.sessionId, options, EDGE);
                    signal.publish();
                    if (result.ok) accepted.push(result.receipt.requestId);
                    return result;
                };
                const beginStop = () => mgmt.stopSessionTurn(session.sessionId, { reason: `matrix Stop ${label}`, timeoutMs: 30_000 });
                const finishStop = async (promise) => {
                    await signal.until(() => stoppedGeneration === generation ? true : null, "actual local Stop fence");
                    blockClaims = false;
                    claimCut.release();
                    const result = await promise;
                    assert(["stopped", "stop_forced"].includes(result.outcome), `Stop actual outcome: ${result.outcome}`);
                    running = false;
                    await signal.until(async () => {
                        const events = await ledger();
                        return events.find((event) => event.eventType === "session.turn_stopped" && event.data?.turnIndex === result.turnIndex);
                    }, "authoritative durable Stop event");
                    modelCut.release();
                    toolCut.release();
                    followCut.release();
                    return result;
                };
                const stop = () => finishStop(beginStop());
                const closed = (id) => waitReceipt(id, (value) => ["closed", "withdrawn"].includes(value.status), "honest terminal receipt");
                const assertAfterStop = async (ids = accepted) => {
                    const requestsAtStop = model.sessionRequests().length;
                    const current = await Promise.all(ids.map(receipt));
                    const attempts = current.map((value) => value.attempts);
                    const saved = await manager.sessionStore.probeSnapshot(session.sessionId);
                    assertEqual(saved.version, 1, "Stop does not publish the dirty target conversation");
                    assertEqual(await session.sendAndWait(`matrix-convergence-${label}`, 30_000), "session usable after Stop");
                    assertEqual(model.sessionRequests().length, requestsAtStop + 1, "only the explicit next turn starts model work");
                    assertEqual(requestsAfterStop.length, 0, "endpoint tripwire: no stopped-generation model work begins");
                    assertEqual(toolsAfterStop.length, 0, "no stopped-generation tool execution starts");
                    expect((await Promise.all(ids.map(receipt))).map((value) => value.attempts)).toEqual(attempts,
                        "accepted requests never resend during subsequent usable work");
                    assertEqual((await manager.sessionStore.probeSnapshot(session.sessionId)).version, 2);
                };
                const assertReceipt = async (id, { disposition, attemptCount, deliveryKind = null, closure = "stopped", reuse = false }) => {
                    const value = await closed(id);
                    assertEqual(value.closureReason, closure);
                    assertEqual(value.eligibility.state, "terminal");
                    assertEqual(value.attempts.total, attemptCount);
                    assertEqual(value.inclusion.state, "not_included", "inclusion follows unchanged saved base, not observed delivery");
                    if (attemptCount) {
                        assertEqual(value.attempts.items[0].deliveryKind, deliveryKind);
                        if (deliveryKind) {
                            assert(value.attempts.items[0].deliveredAt !== null);
                            assertEqual(value.attempts.items[0].outcome, "delivered");
                        } else assertEqual(value.attempts.items[0].deliveredAt, null);
                    }
                    const authorized = await mgmt.getSteeringRequest(session.sessionId, id, {}, EDGE);
                    assertEqual(authorized.actions.canSendAsNewMessage, reuse);
                    assertEqual(value.disposition, disposition);
                    return value;
                };
                const assertLedger = async (ids, deliveredIds = []) => {
                    const events = await ledger();
                    for (let i = 1; i < events.length; i++) assert(events[i].seq > events[i - 1].seq, "durable seq order is strictly increasing");
                    for (const id of ids) {
                        const acceptance = events.filter((event) => event.eventType === "session.steering_accepted" && event.data?.receipt?.requestId === id);
                        assertEqual(acceptance.length, 1);
                        const projection = events.filter((event) => event.eventType === "user.message" && event.data?.steering?.requestId === id);
                        assertEqual(projection.length, deliveredIds.includes(id) ? 1 : 0);
                        if (projection.length) assert(projection[0].seq > acceptance[0].seq, "delivery follows acceptance");
                    }
                    assert(events.some((event) => event.eventType === "session.turn_stopped"),
                        "authoritative Stop closure is represented durably");
                    assert(events.some((event) => event.eventType === "session.steering_window_changed" && event.data?.state === "closed"),
                        "closed steering window is projected durably");
                    return events;
                };
                await run({
                    session, catalog, mgmt, workerCatalog, manager, model, signal, start, accept, state, receipt, ledger,
                    stop, beginStop, finishStop, closed, assertReceipt, assertLedger, assertAfterStop, waitReceipt,
                    get cuts() { return { modelCut, toolCut, followCut, claimCut, stopCut, stopReturnCut }; },
                    blockClaim() { blockClaims = true; },
                    allowClaim() { blockClaims = false; claimCut.release(); },
                    holdStop() { holdStop = true; },
                    releaseStop() { holdStop = false; stopCut.release(); },
                    holdStopAfterFence() { holdStopReturn = true; },
                    releaseStopAfterFence() { holdStopReturn = false; stopReturnCut.release(); },
                    attachStopFence,
                    assertNoStoppedWork() {
                        assertEqual(requestsAfterStop.length, 0, "no stopped-generation model work began");
                        assertEqual(toolsAfterStop.length, 0, "no stopped-generation tool work began");
                    },
                });
                console.log(`  ${label}: receipt + durable ledger/order + stopped-generation work fence + next-turn usability asserted`);
            } finally {
                holdStop = false;
                holdStopReturn = false;
                stopCut.release();
                stopReturnCut.release();
                blockClaims = false;
                for (const cut of [claimCut, modelCut, toolCut, followCut]) cut.release();
                try {
                    if (session && running) await mgmt.stopSessionTurn(session.sessionId, { reason: "Stop-matrix cleanup", timeoutMs: 30_000 });
                } finally {
                    for (const restore of restorers.reverse()) restore();
                    await mgmt.stop();
                    await catalog.close();
                }
            }
        });
    } finally {
        for (const cut of [claimCut, modelCut, toolCut, followCut, stopCut, stopReturnCut]) cut.release();
        await env.cleanup();
    }
}

describe.concurrent("session steering actual turn / steer / Stop matrix", () => {
    it("C1: accepted -> Stop before claim retains reusable text without SDK delivery", { timeout: TIMEOUT }, async () => {
        await fixture("C1", { pending: true }, async (h) => {
            await h.start();
            await within(h.cuts.claimCut.entered, "pump before real claim");
            const steer = await h.accept();
            assertEqual(steer.ok, true);
            assertEqual((await h.receipt(steer.receipt.requestId)).status, "pending");
            await h.stop();
            await h.assertAfterStop();
            await h.assertReceipt(steer.receipt.requestId, { disposition: "not_delivered_turn_stopped", attemptCount: 0, reuse: true });
            await h.assertLedger([steer.receipt.requestId]);
        });
    });

    it("C2: issued/acknowledged send without user.message -> Stop is unconfirmed, never delivered", { timeout: TIMEOUT }, async () => {
        await fixture("C2", {}, async (h) => {
            await h.start();
            await within(h.cuts.modelCut.entered, "real in-flight model response");
            const steer = await h.accept();
            assertEqual(steer.ok, true);
            await h.waitReceipt(steer.receipt.requestId, (value) => value.status === "submitted", "SDK acknowledged before model uptake");
            await h.stop();
            await h.assertAfterStop();
            await h.assertReceipt(steer.receipt.requestId, { disposition: "delivery_unconfirmed", attemptCount: 1 });
            await h.assertLedger([steer.receipt.requestId]);
        });
    });

    it("C3: current-turn steering delivery -> Stop preserves delivery, not dirty snapshot inclusion", { timeout: TIMEOUT }, async () => {
        await fixture("C3", { mode: "tool" }, async (h) => {
            await h.start();
            await within(h.cuts.toolCut.entered, "real running tool");
            const steer = await h.accept();
            await h.waitReceipt(steer.receipt.requestId, (value) => value.status === "submitted", "handoff during tool");
            h.cuts.toolCut.release();
            await within(h.cuts.followCut.entered, "next model request after actual steering boundary");
            await h.waitReceipt(steer.receipt.requestId, (value) => value.status === "delivered", "correlated steering delivery");
            await h.stop();
            await h.assertAfterStop();
            await h.assertReceipt(steer.receipt.requestId, { disposition: "delivered_before_stop", attemptCount: 1, deliveryKind: "steering" });
            await h.assertLedger([steer.receipt.requestId], [steer.receipt.requestId]);
        });
    });

    it("C4: queued delivery -> Stop records delivered-before-Stop with after-response evidence", { timeout: TIMEOUT }, async () => {
        await fixture("C4", {}, async (h) => {
            await h.start();
            await within(h.cuts.modelCut.entered, "earlier no-tool answer held");
            const steer = await h.accept();
            await h.waitReceipt(steer.receipt.requestId, (value) => value.status === "submitted", "immediate input queued before response");
            h.cuts.modelCut.release();
            await within(h.cuts.followCut.entered, "real queued follow-up model request");
            await h.waitReceipt(steer.receipt.requestId, (value) => value.status === "delivered", "queued correlated event");
            await h.stop();
            await h.assertAfterStop();
            const events = await h.assertLedger([steer.receipt.requestId], [steer.receipt.requestId]);
            const response = events.find((event) => event.eventType === "assistant.message" && event.data?.content?.includes("earlier response"));
            const projection = events.find((event) => event.eventType === "user.message" && event.data?.steering?.requestId === steer.receipt.requestId);
            const followStart = events.find((event) => event.eventType === "assistant.turn_start" && event.seq > projection.seq);
            assert(response && followStart);
            assert(response.seq < projection.seq && projection.seq < followStart.seq, "earlier answer -> queued steer -> owned follow-up order");
            await h.assertReceipt(steer.receipt.requestId, { disposition: "delivered_before_stop", attemptCount: 1, deliveryKind: "queued" });
        });
    });

    it("C5: first delivered, second pending -> Stop preserves separate ordered outcomes", { timeout: TIMEOUT }, async () => {
        await fixture("C5", { mode: "tool" }, async (h) => {
            await h.start();
            await within(h.cuts.toolCut.entered, "real tool batch");
            const first = await h.accept();
            await h.waitReceipt(first.receipt.requestId, (value) => value.status === "submitted", "first handoff");
            h.cuts.toolCut.release();
            await within(h.cuts.followCut.entered, "first steer reached current turn");
            await h.waitReceipt(first.receipt.requestId, (value) => value.status === "delivered", "first positive receipt");
            h.blockClaim();
            await within(h.cuts.claimCut.entered, "second claim held");
            const second = await h.accept();
            assertEqual((await h.receipt(second.receipt.requestId)).status, "pending");
            await h.stop();
            await h.assertAfterStop();
            await h.assertReceipt(first.receipt.requestId, { disposition: "delivered_before_stop", attemptCount: 1, deliveryKind: "steering" });
            await h.assertReceipt(second.receipt.requestId, { disposition: "not_delivered_turn_stopped", attemptCount: 0, reuse: true });
            const events = await h.assertLedger([first.receipt.requestId, second.receipt.requestId], [first.receipt.requestId]);
            const accepts = events.filter((event) => event.eventType === "session.steering_accepted");
            expect(accepts.map((event) => event.data.receipt.requestId)).toEqual([first.receipt.requestId, second.receipt.requestId]);
            assert(first.receipt.sequence < second.receipt.sequence);
        });
    });

    it("C6: Stop first -> steer has no_active_turn and creates no input", { timeout: TIMEOUT }, async () => {
        await fixture("C6", {}, async (h) => {
            const oldTarget = await h.start();
            await within(h.cuts.modelCut.entered, "running turn before Stop");
            await h.stop();
            const refused = await h.accept(oldTarget);
            expect(refused).toMatchObject({ ok: false, code: "no_active_turn" });
            await h.assertAfterStop([]);
            const events = await h.assertLedger([]);
            assertEqual(events.filter((event) => event.eventType === "session.steering_accepted").length, 0);
            assertEqual((await h.catalog.steerList(h.session.sessionId)).items.length, 0);
        });
    });

    it("C7: Stop -> new turn rejects old target and accepts only its new target", { timeout: TIMEOUT }, async () => {
        await fixture("C7", { pending: true }, async (h) => {
            const oldTarget = await h.start();
            await within(h.cuts.claimCut.entered, "first claim held");
            await h.stop();
            // The resumed generation gets a fresh held SDK boundary, not a retargeted old request.
            h.blockClaim();
            const newer = await h.start();
            assert(oldTarget !== newer);
            const stale = await h.accept(oldTarget);
            expect(stale).toMatchObject({ ok: false, code: "stale_target" });
            const accepted = await h.accept(newer);
            assertEqual(accepted.ok, true);
            h.allowClaim();
            await h.waitReceipt(accepted.receipt.requestId, (value) => value.status === "submitted", "new target SDK handoff");
            h.cuts.modelCut.release();
            await within(h.cuts.followCut.entered, "new target actual follow-up");
            await h.waitReceipt(accepted.receipt.requestId, (value) => value.status === "delivered", "new target positive delivery");
            h.cuts.followCut.release();
            const positive = await h.waitReceipt(accepted.receipt.requestId, (value) => value.status === "closed", "new target delivered/finalized");
            assert(["delivered_current_turn", "delivered_after_response"].includes(positive.disposition));
            assertEqual(positive.expectedTarget, newer);
            assertEqual(positive.inclusion.state, "included");
            assertEqual(positive.attempts.total, 1);
            const events = await h.assertLedger([positive.requestId], [positive.requestId]);
            assertEqual(events.filter((event) => event.eventType === "session.steering_accepted").length, 1);
            assertEqual(events.filter((event) => event.eventType === "user.message" && event.data?.steering?.requestId === positive.requestId).length, 1);
            const stopped = events.find((event) => event.eventType === "session.turn_stopped");
            const newWindow = events.find((event) => event.eventType === "session.steering_window_changed"
                && event.data?.state === "open" && event.data?.expectedTarget === newer);
            const acceptance = events.find((event) => event.eventType === "session.steering_accepted");
            assert(stopped.seq < newWindow.seq && newWindow.seq < acceptance.seq,
                "old Stop -> new window -> new-target acceptance follows durable order");
            assertEqual(await h.session.sendAndWait("matrix-convergence-C7", 30_000), "session usable after Stop");
            assertEqual((await h.catalog.steerGet(h.session.sessionId, positive.requestId)).attempts.total, 1);
            h.assertNoStoppedWork();
        });
    });

    for (const order of ["withdraw-then-stop", "stop-then-withdraw"]) {
        it(`C8: ${order} has atomic, honest withdrawal and Stop outcomes`, { timeout: TIMEOUT }, async () => {
            await fixture(`C8-${order}`, { pending: true }, async (h) => {
                await h.start();
                await within(h.cuts.claimCut.entered, "pending withdrawal/Stop cut");
                const accepted = await h.accept();
                let withdrawal;
                if (order === "withdraw-then-stop") {
                    withdrawal = await h.mgmt.withdrawSteeringRequest(h.session.sessionId, accepted.receipt.requestId, EDGE);
                    h.signal.publish();
                    assertEqual(withdrawal.outcome, "withdrawn");
                }
                await h.stop();
                if (order === "stop-then-withdraw") {
                    withdrawal = await h.mgmt.withdrawSteeringRequest(h.session.sessionId, accepted.receipt.requestId, EDGE);
                    assertEqual(withdrawal.outcome, "already_settled");
                }
                await h.assertAfterStop();
                await h.assertReceipt(accepted.receipt.requestId, {
                    disposition: order === "withdraw-then-stop" ? "withdrawn" : "not_delivered_turn_stopped",
                    closure: order === "withdraw-then-stop" ? "withdrawn" : "stopped", attemptCount: 0, reuse: true,
                });
                await h.assertLedger([accepted.receipt.requestId]);
            });
        });
    }

    for (const acceptedFirst of [true, false]) {
        it(`C9: ${acceptedFirst ? "accept while Stop RPC waits" : "Stop fence before accept"} produces exactly one honest disposition`, { timeout: TIMEOUT }, async () => {
            await fixture(`C9-${acceptedFirst}`, { pending: true }, async (h) => {
                const target = await h.start();
                await within(h.cuts.claimCut.entered, "race pump claim held");
                h.holdStop();
                if (!acceptedFirst) h.holdStopAfterFence();
                const stopping = h.beginStop();
                await within(h.cuts.stopCut.entered, "Stop RPC is in flight before local fence");
                let accepted;
                if (acceptedFirst) {
                    accepted = await h.accept(target);
                    assertEqual(accepted.ok, true);
                }
                h.releaseStop();
                const finishing = h.finishStop(stopping);
                if (!acceptedFirst) {
                    await within(h.cuts.stopReturnCut.entered, "Stop local fence completed while the actual Stop RPC is still in flight");
                    accepted = await h.accept(target);
                    assert(accepted.ok || accepted.code === "no_active_turn",
                        "an in-flight Stop race has only acceptance or a typed no-active-turn refusal");
                    h.releaseStopAfterFence();
                }
                await finishing;
                await h.assertAfterStop();
                const events = await h.assertLedger(accepted.ok ? [accepted.receipt.requestId] : []);
                assertEqual(events.filter((event) => event.eventType === "session.steering_accepted").length, accepted.ok ? 1 : 0);
                if (accepted.ok) await h.assertReceipt(accepted.receipt.requestId, {
                    disposition: "not_delivered_turn_stopped", attemptCount: 0, reuse: true,
                });
            });
        });
    }

    it("C10: Stop during an existing tool with pending guidance never starts a new tool or delivers it", { timeout: TIMEOUT }, async () => {
        await fixture("C10", { mode: "tool", pending: true }, async (h) => {
            await h.start();
            await within(h.cuts.toolCut.entered, "actual existing running tool");
            await within(h.cuts.claimCut.entered, "pending steer claim held during tool");
            const accepted = await h.accept();
            assertEqual(accepted.ok, true);
            assertEqual((await h.receipt(accepted.receipt.requestId)).status, "pending");
            await h.stop();
            await h.assertAfterStop();
            await h.assertReceipt(accepted.receipt.requestId, { disposition: "not_delivered_turn_stopped", attemptCount: 0, reuse: true });
            const events = await h.assertLedger([accepted.receipt.requestId]);
            assertEqual(events.filter((event) => event.eventType === "tool.execution_start" && event.data?.toolName === "matrix_held_tool").length, 1);
        });
    });
});
