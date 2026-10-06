import { describe, expect, it } from "vitest";
import {
    DEFAULT_STEERING_LIMITS, decodeSteeringListCursor, decodeSteeringTarget, encodeSteeringListCursor,
    encodeSteeringTarget, isValidClientRequestId, normalizeSteerText, sameSteeringActor,
    steeringActorFromSender, steeringContentHash, toSteeringReceipt,
} from "../../src/steering.ts";
import { assert, assertEqual } from "../helpers/assertions.js";

describe.concurrent("session steering pure R1 contract", () => {
    it("ST-U01: opaque target encodes full session/epoch/turn/incarnation and refuses malformed tokens", () => {
        const target = { epoch: 2, turnIndex: 7, incarnation: "snapshot-key" };
        const token = encodeSteeringTarget("session-a", target);
        expect(decodeSteeringTarget(token)).toEqual({ sessionId: "session-a", ...target });
        for (const input of [null, {}, "", "st2." + token.slice(4), token + "=", "st1._", "st1." + "x".repeat(1025)]) {
            assertEqual(decodeSteeringTarget(input), null, "malformed target never becomes current target");
        }
        assert(token !== encodeSteeringTarget("session-b", target));
        assert(token !== encodeSteeringTarget("session-a", { ...target, incarnation: "other-key" }));
        assert(token !== encodeSteeringTarget("session-a", { ...target, epoch: 3 }));
    });

    it("ST-U02: normalization is deterministic and counts trimmed UTF-8 bytes", () => {
        expect(DEFAULT_STEERING_LIMITS).toEqual({ maxBytes: 8192, maxUnresolved: 16, ratePerMinute: 30 });
        expect(normalizeSteerText("  \u00e9\u00e9  ", 4)).toEqual({ ok: true, text: "\u00e9\u00e9", bytes: 4 });
        expect(normalizeSteerText("\u00e9\u00e9a", 4)).toMatchObject({ ok: false, code: "too_large", bytes: 5, limit: 4 });
        for (const input of [null, {}, 1, " \n "]) expect(normalizeSteerText(input)).toEqual({ ok: false, code: "invalid" });
        assertEqual(steeringContentHash(normalizeSteerText(" guidance ").text), steeringContentHash("guidance"));
        assert(steeringContentHash("guidance") !== steeringContentHash("changed guidance"));
    });

    it("ST-U02/ST-U08: request identity is explicit and only user senders supply canonical actors", () => {
        assertEqual(isValidClientRequestId("caller-generated-id"), true);
        assertEqual(isValidClientRequestId("x".repeat(200)), true);
        for (const id of ["", "x".repeat(201), "has space", "has\nnewline", "\u00e9", null]) assertEqual(isValidClientRequestId(id), false);
        for (const sender of [null, {}, { kind: "system", provider: "test", subject: "alice" },
            { kind: "agent", provider: "test", subject: "alice" }, { kind: "user", provider: "test" }]) {
            assertEqual(steeringActorFromSender(sender), null);
        }
        const user = steeringActorFromSender({ kind: "user", provider: "test", subject: "alice", display: "Alice" });
        assertEqual(user.subject, "alice");
        assertEqual(user.displayName, "Alice");
        assertEqual(sameSteeringActor(user, { provider: "other", subject: "alice" }), false);
        assertEqual(sameSteeringActor(user, { provider: "test", subject: "alice", displayName: "Different" }), true);
    });

    it("ST-A03/ST-A05: viewer actions cannot grant a different writer withdrawal authority", () => {
        const record = { status: "pending", disposition: "accepted", actor: { provider: "test", subject: "alice" } };
        const viewer = { actor: { provider: "test", subject: "bob" }, canWrite: true, isManager: false };
        expect(toSteeringReceipt(record, viewer).actions).toEqual({ canWithdraw: false, canSendAsNewMessage: false });
        expect(toSteeringReceipt(record, { ...viewer, isManager: true }).actions).toEqual({ canWithdraw: true, canSendAsNewMessage: false });
        expect(toSteeringReceipt(record, { ...viewer, actor: record.actor }).actions).toEqual({ canWithdraw: true, canSendAsNewMessage: false });
        for (const status of ["claimed", "submitting", "submitted", "delivered", "orphaned", "closed", "withdrawn"]) {
            assertEqual(toSteeringReceipt({ ...record, status }, { ...viewer, isManager: true }).actions.canWithdraw, false);
        }
        const retained = { ...record, status: "closed", disposition: "not_delivered_turn_ended" };
        assertEqual(toSteeringReceipt(retained, viewer).actions.canSendAsNewMessage, true);
        expect(toSteeringReceipt(retained, { ...viewer, canWrite: false }).actions).toEqual({ canWithdraw: false, canSendAsNewMessage: false });
        assertEqual(record.actions, undefined, "viewer actions never mutate the broadcast record");
    });

    it("ST-A05: list cursor is bound to session and filter set, with lossless safe sequence", () => {
        const filter = { dispositions: ["accepted", "withdrawn"], expectedTarget: "target-a" };
        const cursor = encodeSteeringListCursor("session-a", filter, 42);
        assertEqual(decodeSteeringListCursor("session-a", filter, cursor), 42);
        assertEqual(decodeSteeringListCursor("session-a", { ...filter, dispositions: [...filter.dispositions].reverse() }, cursor), 42);
        assertEqual(decodeSteeringListCursor("session-b", filter, cursor), null);
        assertEqual(decodeSteeringListCursor("session-a", { ...filter, expectedTarget: "target-b" }, cursor), null);
        assertEqual(decodeSteeringListCursor("session-a", { ...filter, dispositions: ["accepted"] }, cursor), null);
        assertEqual(decodeSteeringListCursor("session-a", filter, "not-json"), null);
        const unsafe = encodeSteeringListCursor("session-a", filter, Number.MAX_SAFE_INTEGER + 1);
        assertEqual(decodeSteeringListCursor("session-a", filter, unsafe), null);
    });
});
