/**
 * Durable recipient intake, the sender (design docs/proposals/workflow-
 * durable-intake.md sections 3 and 4; inactive: no worker turns the
 * deployment capability on). On the real PostgreSQL store:
 *
 * - The deciding count: an intake-capable count decides the message's mode
 *   on its first count only: durable with a new attempt token when the
 *   capability is on and the recipient was observed at 1.0.83 or later,
 *   otherwise legacy_window; a durable message gets a new token on every
 *   later count, also after the capability is turned off; a message first
 *   counted by a build without the intake never becomes durable, and that
 *   build cannot count a durable one (the outbox's fence).
 * - The receipt says durable only for a durable delivery, which the store
 *   records only on a durable message; every other receipt keeps its shape
 *   and reads as legacy_window.
 * - The deliver activity: with the capability on and a 1.0.83 recipient,
 *   every copy carries the intake envelope, and the recipient's claim
 *   verifies it against the store; with the capability off, an older or an
 *   unknown recipient version, the copy is plain and the message legacy. A
 *   failed version lookup fails the attempt before its count, with nothing
 *   enqueued, and an ended recipient's version is never read. A delivery
 *   whose record is lost is delivered again as the same durable copy (same
 *   envelope and client message id) under a new attempt token, also once
 *   the capability is off, and its receipt says durable.
 * - The session queue reads the recipient's version from its instance,
 *   throws a failed read, and puts the envelope on a copy only when given
 *   one; the version check accepts only bounded, well-formed versions.
 * - The generic event ingress (PilotSwarmSession.sendEvent, which every
 *   transport reaches) refuses the reserved `workflowIntake` field in the
 *   text it enqueues, a toJSON's included (design 3, defense in depth), and
 *   enqueues exactly that text.
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { intakeActivityFixture, INTAKE_ACTIVITY_TIMEOUT } from "../helpers/workflow-v2-intake-activities-fixture.js";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { nodeExecutionIdFor, parseSendReceipt } from "../../src/workflow/v2/store.ts";
import {
    intakeCapableVersion, registerWorkflowV2, sessionQueueTransport, WORKFLOW_V2_ACTIVITIES, workflowSendClientMessageId, workflowSendIntakeEnvelope,
} from "../../src/workflow/v2/runtime.ts";
import { PilotSwarmSession } from "../../src/client.ts";

const getEnv = useSuiteEnv(import.meta.url);

/** A send state of the fixture's workflow entered (its message stored), not yet counted. */
async function enter(h, ordinal, payload = { note: `item ${ordinal}` }) {
    const exchangeId = nodeExecutionIdFor(h.runId, "root", "tell", ordinal);
    const payloadText = canonicalJson(payload);
    const refusal = code => ({ result: { outcome: code, resultKind: "runtime_error", valueText: canonicalJson({ code, message: code }), winner: "controller" } });
    expect(await h.store.enterNode({ runId: h.runId, nodeExecutionId: exchangeId, scopeId: "root", nodeId: "tell", ordinal,
        nodeType: "messaging", predecessorId: null, arrivalRoute: null, inputText: payloadText, kvRevision: 1,
        waitSeconds: null, immediate: null, send: { recipient: h.recipientSessionId, contract: "Note@1", payloadText,
            correlationText: "{}", refused: { unavailable: refusal("unavailable"), forbidden: refusal("forbidden") } } }))
        .toMatchObject({ admitted: true, inserted: true });
    return exchangeId;
}

const refusalResult = code => ({ result: { outcome: code, resultKind: "runtime_error", valueText: canonicalJson({ code, message: code }), winner: "delivery" } });
const refusals = h => ({
    refused: { unavailable: refusalResult("unavailable"), forbidden: refusalResult("forbidden") }, ended: null,
    delivered: { stateId: "tell", projection: () => ({ sessionId: h.workflowSessionId }) },
});
const outboxIntake = async (h, exchangeId) => (await h.q(
    "SELECT attempts, intake_mode, attempt_token FROM SCHEMA.workflow_outbox WHERE exchange_id = $1", [exchangeId]))[0];
const projection = h => () => ({ sessionId: h.workflowSessionId });

describe("workflow v2 durable intake: the sender (store, inactive)", () => {
    it("decides the mode on the first count only, durable with a new token on every count, never promoted later", { timeout: INTAKE_ACTIVITY_TIMEOUT }, async () => {
        const h = await intakeActivityFixture(getEnv());
        try {
            const [a, b, c, d] = [await enter(h, 1), await enter(h, 2), await enter(h, 3), await enter(h, 4)];
            // Eligible on its first count: durable, with the attempt's token; the answer says the copies carry the envelope.
            expect(await h.store.beginDelivery(a, refusals(h), { durable: true, attemptToken: "token-a1" }))
                .toMatchObject({ kind: "deliver", durable: true, message: { attempts: 1 } });
            expect(await outboxIntake(h, a)).toEqual({ attempts: 1, intake_mode: "durable", attempt_token: "token-a1" });
            // Every later count of a durable message sets a new token, the capability turned off since included.
            expect(await h.store.beginDelivery(a, refusals(h), { durable: false, attemptToken: "token-a2" }))
                .toMatchObject({ kind: "deliver", durable: true, message: { attempts: 2 } });
            expect(await outboxIntake(h, a)).toEqual({ attempts: 2, intake_mode: "durable", attempt_token: "token-a2" });
            // A build without the intake cannot count a durable message: the fence refuses it, and nothing changes.
            await expect(h.store.beginDelivery(a, refusals(h))).rejects.toThrow(/an attempt of a durable exchange needs a new attempt token/);
            expect(await outboxIntake(h, a)).toEqual({ attempts: 2, intake_mode: "durable", attempt_token: "token-a2" });

            // Not eligible on its first count: legacy_window, and it never becomes durable.
            expect(await h.store.beginDelivery(b, refusals(h), { durable: false, attemptToken: "token-b1" }))
                .toMatchObject({ kind: "deliver", durable: false, message: { attempts: 1 } });
            expect(await h.store.beginDelivery(b, refusals(h), { durable: true, attemptToken: "token-b2" }))
                .toMatchObject({ kind: "deliver", durable: false, message: { attempts: 2 } });
            expect(await outboxIntake(h, b)).toEqual({ attempts: 2, intake_mode: "legacy_window", attempt_token: null });

            // First counted by a build without the intake: no mode, which reads as legacy_window; never durable.
            expect(await h.store.beginDelivery(c, refusals(h))).toMatchObject({ kind: "deliver", message: { attempts: 1 } });
            expect(await h.store.beginDelivery(c, refusals(h), { durable: true, attemptToken: "token-c2" }))
                .toMatchObject({ kind: "deliver", durable: false, message: { attempts: 2 } });
            expect(await outboxIntake(h, c)).toEqual({ attempts: 2, intake_mode: null, attempt_token: null });

            // A token that is not an id is refused before anything is read or written.
            await expect(h.store.beginDelivery(d, refusals(h), { durable: true, attemptToken: "" })).rejects.toThrow(/attemptToken/);
            expect(await outboxIntake(h, d)).toEqual({ attempts: 0, intake_mode: null, attempt_token: null });
        } finally { await h.close(); }
    });

    it("records a durable delivery only on a durable message, and only its receipt says so; every other receipt keeps its shape", { timeout: INTAKE_ACTIVITY_TIMEOUT }, async () => {
        const h = await intakeActivityFixture(getEnv());
        try {
            const [a, b] = [await enter(h, 1), await enter(h, 2)];
            const clientMessageId = exchangeId => workflowSendClientMessageId(h.workflowSessionId, h.runId, exchangeId);
            await h.store.beginDelivery(a, refusals(h), { durable: true, attemptToken: "token-a1" });
            await h.store.beginDelivery(b, refusals(h), { durable: false, attemptToken: "token-b1" });

            const durable = await h.store.recordDelivery(a, { stateId: "tell", clientMessageId: clientMessageId(a), input: null, intake: "durable" }, projection(h));
            expect(durable).toMatchObject({ recorded: true, won: true, message: { state: "delivered" } });
            expect(durable.message.receipt).toMatchObject({ intake: "durable", clientMessageId: clientMessageId(a), attempts: 1 });
            expect((await h.store.readOutboxMessage(a)).receipt.intake).toBe("durable");

            // A durable delivery of a legacy message is a broken invariant: nothing is recorded.
            await expect(h.store.recordDelivery(b, { stateId: "tell", clientMessageId: clientMessageId(b), input: null, intake: "durable" }, projection(h)))
                .rejects.toThrow(/delivered in durable intake mode, but its message is not durable/);
            expect((await h.store.readOutboxMessage(b)).state).toBe("pending");
            const legacy = await h.store.recordDelivery(b, { stateId: "tell", clientMessageId: clientMessageId(b), input: null }, projection(h));
            expect(legacy).toMatchObject({ recorded: true, message: { state: "delivered" } });
            expect(Object.hasOwn(legacy.message.receipt, "intake")).toBe(false);

            // The parser: a receipt without the field keeps it absent (legacy_window); a stored one is kept; anything else, or
            // the field on a workflow recipient's receipt, is corrupt.
            const stored = legacy.message.receipt;
            expect(parseSendReceipt(JSON.parse(canonicalJson(stored)))).toEqual(stored);
            expect(parseSendReceipt({ ...stored, intake: "legacy_window" })).toEqual({ ...stored, intake: "legacy_window" });
            expect(() => parseSendReceipt({ ...stored, intake: "other" })).toThrow(/invalid shape/);
            const workflowReceipt = { ...stored, recipientKind: "workflow", clientMessageId: null,
                input: { messageId: "m", runId: "r", acceptedAt: "t", expiresAt: "t", claimedBy: null } };
            expect(() => parseSendReceipt(workflowReceipt)).not.toThrow();
            expect(() => parseSendReceipt({ ...workflowReceipt, intake: "durable" })).toThrow(/invalid shape/);
        } finally { await h.close(); }
    });
});

describe("workflow v2 durable intake: the deliver activity (inactive)", () => {
    /**
     * The deliver activity over the real store (or `store`, a view of it), with a recording session queue; nothing else of
     * the runtime runs. `version` is the recipient's observed version, or the queue's own lookup when a function.
     */
    function deliverer(h, { capability, version, status = "Running", store = h.store }) {
        const activities = {};
        const enqueued = [];
        const queue = {
            status: async () => status,
            ...(version === undefined ? {} : { version: typeof version === "function" ? version : async () => version }),
            enqueue: async (sessionId, message) => { enqueued.push({ sessionId, message }); },
        };
        registerWorkflowV2({ registerActivity: (name, fn) => { activities[name] = fn; }, registerOrchestrationVersioned: () => {} }, {
            store, catalog: h.catalog, enabled: () => true,
            resolveToolBinding: async () => null, openToolExecutor: async () => { throw new Error("no tool runs here"); },
            authorizeParentNotification: async () => false, notifyParent: async () => {}, deleteSession: async () => {},
            sessionQueue: queue, ...(capability === undefined ? {} : { workflowIntake: () => capability }),
        });
        const deliver = exchangeId => activities[WORKFLOW_V2_ACTIVITIES.deliver]({ getClient: () => ({}) },
            { runId: h.runId, nodeExecutionId: exchangeId, controllerInstanceId: `workflow-${h.workflowSessionId}` });
        return { deliver, enqueued };
    }

    it("with the capability on and a 1.0.83 recipient, the copy carries the envelope the recipient's claim verifies, and the receipt says durable", { timeout: INTAKE_ACTIVITY_TIMEOUT }, async () => {
        const h = await intakeActivityFixture(getEnv());
        try {
            const exchangeId = await enter(h, 1);
            const d = deliverer(h, { capability: true, version: "1.0.83" });
            expect(await d.deliver(exchangeId)).toMatchObject({ kind: "delivered", won: true });
            const message = await h.store.readOutboxMessage(exchangeId);
            expect(d.enqueued).toHaveLength(1);
            const copy = d.enqueued[0].message;
            expect(d.enqueued[0].sessionId).toBe(h.recipientSessionId);
            expect(copy.clientMessageId).toBe(workflowSendClientMessageId(h.workflowSessionId, h.runId, exchangeId));
            expect(copy.workflowIntake).toEqual(workflowSendIntakeEnvelope(message));
            expect(message.receipt).toMatchObject({ intake: "durable", attempts: 1 });
            expect(await outboxIntake(h, exchangeId)).toMatchObject({ attempts: 1, intake_mode: "durable" });
            // The recipient verifies the envelope against the store: the claim holds the exchange.
            expect(await h.claim({ recipientSessionId: h.recipientSessionId, envelope: copy.workflowIntake, claimId: "claim-1", mode: "accept" }))
                .toMatchObject({ ok: true, result: { result: "accepted", inserted: true } });
        } finally { await h.close(); }
    });

    it("with the capability off, or an older, an unknown or an unreadable recipient version, the copy is plain and the message legacy", { timeout: INTAKE_ACTIVITY_TIMEOUT }, async () => {
        const h = await intakeActivityFixture(getEnv());
        try {
            const cases = [
                [{ capability: false, version: "1.0.83" }],
                [{ capability: undefined, version: "1.0.83" }],
                [{ capability: true, version: "1.0.82" }],
                [{ capability: true, version: null }],
                [{ capability: true, version: undefined }],
            ];
            for (const [index, [options]] of cases.entries()) {
                const exchangeId = await enter(h, index + 1);
                const d = deliverer(h, options);
                expect(await d.deliver(exchangeId), JSON.stringify(options)).toMatchObject({ kind: "delivered" });
                expect(d.enqueued, JSON.stringify(options)).toHaveLength(1);
                expect(Object.hasOwn(d.enqueued[0].message, "workflowIntake"), JSON.stringify(options)).toBe(false);
                expect(Object.hasOwn((await h.store.readOutboxMessage(exchangeId)).receipt, "intake"), JSON.stringify(options)).toBe(false);
                expect(await outboxIntake(h, exchangeId), JSON.stringify(options)).toMatchObject({ attempts: 1, intake_mode: "legacy_window" });
            }
        } finally { await h.close(); }
    });

    it("a failed version lookup fails the attempt before its count, with nothing enqueued, and the next attempt counts it durable; an ended recipient's version is never read", { timeout: INTAKE_ACTIVITY_TIMEOUT }, async () => {
        const h = await intakeActivityFixture(getEnv());
        try {
            const exchangeId = await enter(h, 1);
            let lookups = 0;
            const d = deliverer(h, { capability: true, version: async () => {
                lookups += 1;
                if (lookups === 1) throw new Error("instance information unavailable");
                return "1.0.83";
            } });
            await expect(d.deliver(exchangeId)).rejects.toThrow(/instance information unavailable/);
            expect(d.enqueued).toEqual([]);
            expect(await outboxIntake(h, exchangeId)).toEqual({ attempts: 0, intake_mode: null, attempt_token: null });
            expect((await h.store.readOutboxMessage(exchangeId)).state).toBe("pending");
            // The next attempt reads the version, and its count decides the mode: durable.
            expect(await d.deliver(exchangeId)).toMatchObject({ kind: "delivered", won: true });
            expect(lookups).toBe(2);
            expect(d.enqueued).toHaveLength(1);
            expect(d.enqueued[0].message.workflowIntake).toEqual(workflowSendIntakeEnvelope(await h.store.readOutboxMessage(exchangeId)));
            expect(await outboxIntake(h, exchangeId)).toMatchObject({ attempts: 1, intake_mode: "durable" });

            // An ended recipient: the attempt is refused as ended without its version read, and nothing is enqueued.
            const ended = await enter(h, 2);
            const e = deliverer(h, { capability: true, status: "Completed", version: async () => { throw new Error("an ended recipient's version was read"); } });
            expect(await e.deliver(ended)).toMatchObject({ kind: "refused" });
            expect(e.enqueued).toEqual([]);
            expect(await outboxIntake(h, ended)).toEqual({ attempts: 0, intake_mode: null, attempt_token: null });
        } finally { await h.close(); }
    });

    it("a delivery whose record is lost is delivered again as the same durable copy under a new token, also with the capability off since; the receipt says durable", { timeout: INTAKE_ACTIVITY_TIMEOUT }, async () => {
        const h = await intakeActivityFixture(getEnv());
        try {
            const exchangeId = await enter(h, 1);
            // The queue accepts the first copy; the attempt's record of it is lost (the activity fails after its enqueue).
            let loseRecord = true;
            const store = new Proxy(h.store, {
                get(target, prop) {
                    if (prop === "recordDelivery" && loseRecord) {
                        return async () => { loseRecord = false; throw new Error("the delivery record was lost"); };
                    }
                    const value = Reflect.get(target, prop, target);
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            const first = deliverer(h, { capability: true, version: "1.0.83", store });
            await expect(first.deliver(exchangeId)).rejects.toThrow(/the delivery record was lost/);
            expect(first.enqueued).toHaveLength(1);
            const before = await outboxIntake(h, exchangeId);
            expect(before).toMatchObject({ attempts: 1, intake_mode: "durable" });
            expect((await h.store.readOutboxMessage(exchangeId)).state).toBe("pending");

            // The retry runs where the capability is off and no version is known: the first count made the message durable.
            const retry = deliverer(h, { capability: false, store });
            expect(await retry.deliver(exchangeId)).toMatchObject({ kind: "delivered", won: true });
            expect(retry.enqueued).toHaveLength(1);
            const after = await outboxIntake(h, exchangeId);
            expect(after).toMatchObject({ attempts: 2, intake_mode: "durable" });
            expect(after.attempt_token).not.toBe(before.attempt_token);
            const [lost, again] = [first.enqueued[0].message, retry.enqueued[0].message];
            expect(again).toEqual(lost);
            expect(again.workflowIntake).toEqual(workflowSendIntakeEnvelope(await h.store.readOutboxMessage(exchangeId)));
            const message = await h.store.readOutboxMessage(exchangeId);
            expect(message).toMatchObject({ state: "delivered", attempts: 2 });
            expect(message.receipt).toMatchObject({ intake: "durable", attempts: 2, clientMessageId: lost.clientMessageId });
            // The recipient's claim verifies the copy against the store.
            expect(await h.claim({ recipientSessionId: h.recipientSessionId, envelope: again.workflowIntake, claimId: "claim-1", mode: "accept" }))
                .toMatchObject({ ok: true, result: { result: "accepted", inserted: true } });
        } finally { await h.close(); }
    });
});

describe("workflow v2 durable intake: the session queue and the version check (inactive)", () => {
    it("the generic event ingress refuses the reserved workflowIntake field in the text it enqueues, a toJSON's included, and enqueues exactly that text (design 3)", async () => {
        const sent = [];
        const client = { _getDuroxideClient: () => ({ enqueueEvent: async (instanceId, queueName, data) => { sent.push({ instanceId, queueName, data }); } }) };
        const session = new PilotSwarmSession("s1", client);
        const envelope = workflowSendIntakeEnvelope({ exchangeId: `nx-${"a".repeat(40)}`, workflowSessionId: "wf", runId: "run",
            recipientSessionId: "s1", contract: "Note@1", payloadSha256: "b".repeat(64) });
        await expect(session.sendEvent("signal", { prompt: "forged", workflowIntake: envelope })).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
        await expect(session.sendEvent("signal", { workflowIntake: null })).rejects.toThrow(/reserved field workflowIntake/);
        // The field added by serialization: refused, as the text that would be enqueued carries it.
        await expect(session.sendEvent("signal", { prompt: "forged", toJSON: () => ({ prompt: "forged", workflowIntake: envelope }) }))
            .rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
        let serializations = 0;
        const changing = { toJSON: () => (serializations++ === 0 ? { prompt: "harmless" } : { prompt: "forged", workflowIntake: envelope }) };
        await session.sendEvent("signal", changing);
        expect(serializations).toBe(1);
        // The field on the event as given is refused even when its serialization would drop it.
        await expect(session.sendEvent("signal", { ready: true, workflowIntake: undefined })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        await expect(session.sendEvent("signal", { workflowIntake: envelope, toJSON: () => ({ prompt: "harmless" }) }))
            .rejects.toMatchObject({ code: "INVALID_REQUEST" });
        // A value JSON cannot serialize throws as before, with nothing enqueued.
        await expect(session.sendEvent("signal", { big: 1n })).rejects.toThrow(TypeError);
        expect(sent).toEqual([
            { instanceId: "session-s1", queueName: "messages", data: JSON.stringify({ prompt: "harmless" }) },
        ]);
        sent.length = 0;
        // Any other event, a nested field of that name included, goes on unchanged.
        await session.sendEvent("signal", { ready: true, detail: { workflowIntake: "not reserved here" } });
        await session.sendEvent("signal", ["a", "list"]);
        await session.sendEvent("signal", null);
        await session.sendEvent("signal", "text");
        await session.sendEvent("signal", 7);
        await session.sendEvent("signal", undefined);
        expect(sent).toEqual([
            { instanceId: "session-s1", queueName: "messages", data: JSON.stringify({ ready: true, detail: { workflowIntake: "not reserved here" } }) },
            { instanceId: "session-s1", queueName: "messages", data: JSON.stringify(["a", "list"]) },
            { instanceId: "session-s1", queueName: "messages", data: "null" },
            { instanceId: "session-s1", queueName: "messages", data: '"text"' },
            { instanceId: "session-s1", queueName: "messages", data: "7" },
            { instanceId: "session-s1", queueName: "messages", data: undefined },
        ]);
    });

    it("reads the recipient's version from its instance, throws a failed read, fails closed, and puts the envelope only on a copy given one", async () => {
        const events = [];
        const client = (info) => ({
            getStatus: async () => ({ status: "Running" }),
            enqueueEvent: async (instanceId, queueName, data) => { events.push({ instanceId, queueName, data: JSON.parse(data) }); },
            ...(info === undefined ? {} : { getInstanceInfo: async () => { if (info instanceof Error) throw info; return info; } }),
        });
        expect(await sessionQueueTransport(client({ orchestrationVersion: "1.0.83" })).version("s1")).toBe("1.0.83");
        expect(await sessionQueueTransport(client({ orchestrationVersion: "" })).version("s1")).toBeNull();
        expect(await sessionQueueTransport(client({})).version("s1")).toBeNull();
        expect(await sessionQueueTransport(client(null)).version("s1")).toBeNull();
        // A client without instance information cannot tell; a read that fails is thrown, never read as unknown.
        expect(await sessionQueueTransport(client(undefined)).version("s1")).toBeNull();
        await expect(sessionQueueTransport(client(new Error("instance information unavailable"))).version("s1"))
            .rejects.toThrow(/instance information unavailable/);

        const queue = sessionQueueTransport(client(undefined));
        const sender = { kind: "system", display: "workflow message" };
        const envelope = workflowSendIntakeEnvelope({ exchangeId: `nx-${"a".repeat(40)}`, workflowSessionId: "wf", runId: "run",
            recipientSessionId: "s1", contract: "Note@1", payloadSha256: "b".repeat(64) });
        await queue.enqueue("s1", { prompt: "plain", sender, clientMessageId: "c1" });
        await queue.enqueue("s1", { prompt: "durable", sender, clientMessageId: "c2", workflowIntake: envelope });
        expect(events).toEqual([
            { instanceId: "session-s1", queueName: "messages", data: { prompt: "plain", sender, clientMessageIds: ["c1"] } },
            { instanceId: "session-s1", queueName: "messages", data: { prompt: "durable", sender, clientMessageIds: ["c2"], workflowIntake: envelope } },
        ]);

        for (const [version, capable] of [
            ["1.0.83", true], ["1.0.84", true], ["1.1.0", true], ["2.0.0", true], ["1.0.82", false], ["0.9.99", false],
            ["1.0", false], ["1.0.83.1", false], ["", false], [null, false], [undefined, false], ["v1.0.83", false],
            ["1.0.999999999", true], ["999999999.0.0", true],
            // Malformed or oversized: a leading zero, a tenth digit, a sign, an exponent, whitespace, a trailing newline, a non-string.
            ["1.0.083", false], ["01.0.83", false], ["1.0.1000000000", false], ["9007199254740993.0.0", false], ["1.0.-83", false],
            ["1.0.8e1", false], [" 1.0.83", false], ["1.0.83 ", false], ["1.0.83\n", false], ["1.0.83\r\n", false], [1.083, false],
            [{ toString: () => "1.0.83" }, false],
        ]) {
            expect(intakeCapableVersion(version), String(version)).toBe(capable);
        }
    });
});
