import { describe, expect, it, vi } from "vitest";
import { PortalRuntime } from "../../../app/web/runtime.js";
import { OPERATIONS } from "../../api/src/protocol.js";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";
import { WebPilotSwarmManagementClient } from "../../src/web/web-management-client.ts";
import { evaluateSessionAccess } from "../../api/src/session-authz.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const OPERATIONS_REQUIRED = [
    ["getSessionSteeringState", "GET", "/management/sessions/:sessionId/steering-state", "session:read"],
    ["steerSessionTurn", "POST", "/management/sessions/:sessionId/steering", "session:write"],
    ["getSteeringRequest", "GET", "/management/sessions/:sessionId/steering/:requestId", "session:read"],
    ["listSteeringRequests", "GET", "/management/sessions/:sessionId/steering", "session:read"],
    ["withdrawSteeringRequest", "POST", "/management/sessions/:sessionId/steering/:requestId/withdraw", "session:read"],
    ["getSessionSteeringStats", "GET", "/management/sessions/:sessionId/steering-stats", "session:read"],
];
const as = (subject, role = "user") => ({
    principal: { provider: "dev", subject, displayName: subject },
    authorization: { role },
});
const receipt = () => ({
    schemaVersion: 1, sessionId: "steer-session", requestId: "request-a", clientRequestId: "caller-a",
    expectedTarget: "opaque-target", sequence: 1, acceptedAt: "2026-01-01T00:00:00.000Z",
    actor: { provider: "dev", subject: "alice" }, text: "private guidance", revision: 1,
    status: "pending", disposition: "accepted", eligibility: { state: "pending", reason: null },
    inclusion: { state: "unconfirmed", snapshotVersion: null }, recoveryFlags: [],
    attempts: { items: [], nextCursor: null }, actions: { canWithdraw: true, canSendAsNewMessage: false },
});

function makeRuntime({ enforce = true, visibility = "private", share = null, missing = false, adminScope = "unrestricted" } = {}) {
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce, adminScope, systemVisibility: "read" };
    const audit = [];
    const controls = Object.fromEntries(OPERATIONS_REQUIRED.map(([name]) => [name, vi.fn(async () => receipt())]));
    controls.steerSessionTurn = vi.fn(async () => ({ ok: true, duplicate: false, receipt: receipt() }));
    controls.getSessionSteeringState = vi.fn(async () => ({
        steerable: true, expectedTarget: "opaque-target", reason: null,
        limits: { maxBytes: 16_384, perSessionPerMinute: 30, perActorPerMinute: 60, maxUnresolved: 5 },
    }));
    controls.listSteeringRequests = vi.fn(async () => ({ items: [receipt()], nextCursor: null }));
    controls.withdrawSteeringRequest = vi.fn(async () => ({ outcome: "withdrawn", receipt: { ...receipt(), status: "withdrawn", disposition: "withdrawn" } }));
    const snapshotFor = (viewer) => missing ? null : ({
        rootSessionId: "steer-session", isSystem: false, visibility,
        owner: { provider: "dev", subject: "alice", displayName: "Alice" },
        viewerIsOwner: viewer?.provider === "dev" && viewer?.subject === "alice",
        viewerShareAccess: viewer?.subject === "bob" ? share : null,
    });
    runtime.transport = {
        ...controls, mgmt: controls,
        getSessionAccess: vi.fn(async (_id, viewer) => snapshotFor(viewer)),
        recordAuthzAudit: vi.fn(async (entry) => { audit.push(entry); }),
        sendMessage: vi.fn(async () => { throw new Error("fixture: steering must never call ordinary Send"); }),
        sendAnswer: vi.fn(async () => { throw new Error("fixture: steering must never answer a question"); }),
    };
    return { runtime, controls, audit, snapshotFor };
}

const submitParams = () => ({
    sessionId: "steer-session",
    options: { text: "private guidance", clientRequestId: "caller-a", expectedTarget: "opaque-target" },
});

describe.concurrent("session steering management and authorization contract", () => {
    it("ST-A01: direct and web clients expose every declared operation and matching protocol rows", () => {
        for (const [name, method, path, access] of OPERATIONS_REQUIRED) {
            assertEqual(typeof PilotSwarmManagementClient.prototype[name], "function", `direct ${name}`);
            assertEqual(typeof WebPilotSwarmManagementClient.prototype[name], "function", `web ${name}`);
            const operation = OPERATIONS.find((item) => item.name === name);
            assert(operation, `protocol declares ${name}`);
            assertEqual(operation.method, method);
            assertEqual(operation.path, path);
            assertEqual(operation.access, access);
            assertEqual(operation.alwaysEnforce, true, "every steering operation enforces ownership");
        }
        const submit = OPERATIONS.find((item) => item.name === "steerSessionTurn");
        expect(Object.keys(submit.params).sort()).toEqual(["options", "sessionId"]);
        assertEqual(submit.params.options.in, "body");
    });

    it("ST-A01/ST-A04: accepted guidance preserves the exact receipt and server-stamps the actor", async () => {
        const h = makeRuntime();
        const params = submitParams();
        params.sender = { provider: "dev", subject: "mallory", role: "admin", trustedSystem: true };
        const result = await h.runtime.call("steerSessionTurn", params, as("alice"));
        expect(result).toEqual({ ok: true, duplicate: false, receipt: receipt() });
        assertEqual(h.controls.steerSessionTurn.mock.calls.length, 1);
        const call = h.controls.steerSessionTurn.mock.calls[0];
        assertEqual(call[0], params.sessionId);
        expect(call[1]).toEqual(params.options);
        const edge = JSON.stringify(call.slice(2));
        assert(edge.includes("alice"), "validated caller is carried to the trusted management boundary");
        assert(!edge.includes("mallory") && !edge.includes("trustedSystem"), "caller cannot forge identity or trust");
        assertEqual(h.runtime.transport.sendMessage.mock.calls.length, 0);
    });

    for (const [label, options, subject, allowed, status] of [
        ["owner", {}, "alice", true, null],
        ["write share", { share: "write" }, "bob", true, null],
        ["shared write", { visibility: "shared_write" }, "bob", true, null],
        ["read share", { share: "read" }, "bob", false, 403],
        ["shared read", { visibility: "shared_read" }, "bob", false, 403],
        ["unshared", {}, "bob", false, 404],
        ["deleted or unknown", { missing: true }, "alice", false, 404],
    ]) {
        it(`ST-A02: ${label} follows the existing enforcing access policy`, async () => {
            const h = makeRuntime(options);
            const auth = as(subject);
            if (!options.missing) {
                assertEqual(evaluateSessionAccess("session:write", h.snapshotFor(auth.principal)).allowed, allowed, "fixture uses the production predicate");
            }
            if (allowed) {
                expect(await h.runtime.call("steerSessionTurn", submitParams(), auth)).toEqual({ ok: true, duplicate: false, receipt: receipt() });
            } else {
                await expect(h.runtime.call("steerSessionTurn", submitParams(), auth)).rejects.toMatchObject({ status });
                assertEqual(h.controls.steerSessionTurn.mock.calls.length, 0, "denied request cannot reach acceptance");
                assert(h.audit.some((entry) => entry.decision === "deny"), "denial is audited");
            }
            assertEqual(h.runtime.transport.sendMessage.mock.calls.length, 0, "no ordinary-send fallback");
        });
    }

    it("ST-A02/ST-A05: audit-only deployment refuses steering even for its owner", async () => {
        const h = makeRuntime({ enforce: false });
        const state = await h.runtime.call("getSessionSteeringState", { sessionId: "steer-session" }, as("alice"));
        assertEqual(state.steerable, false);
        assertEqual(state.reason, "unsupported");
        assertEqual(state.unsupportedReason, "authz_not_enforced");
        await expect(h.runtime.call("steerSessionTurn", submitParams(), as("alice")))
            .rejects.toMatchObject({ reason: "authz_not_enforced" });
        assertEqual(h.controls.steerSessionTurn.mock.calls.length, 0);
        assertEqual(h.runtime.transport.sendMessage.mock.calls.length, 0);
    });

    it("ST-A03: another writer's withdrawal carries only their validated identity to the enforcing management contract", async () => {
        const h = makeRuntime({ share: "write" });
        await h.runtime.call("withdrawSteeringRequest", { sessionId: "steer-session", requestId: "request-a",
            isManager: true, actor: { provider: "dev", subject: "alice" } }, as("bob"));
        const [sessionId, requestId, edge] = h.controls.withdrawSteeringRequest.mock.calls[0];
        assertEqual(sessionId, "steer-session");
        assertEqual(requestId, "request-a");
        assertEqual(edge.sender.subject, "bob");
        assertEqual(edge.isAdmin, false);
        assertEqual(edge.isManager, undefined, "caller supplied manager authority is not forwarded");
    });

    it("ST-A03: unreadable request IDs are not probed or disclosed", async () => {
        const h = makeRuntime();
        for (const requestId of ["request-a", "guessed-absent"]) {
            await expect(h.runtime.call("withdrawSteeringRequest", { sessionId: "steer-session", requestId }, as("bob")))
                .rejects.toMatchObject({ status: 404 });
        }
        assertEqual(h.controls.getSteeringRequest.mock.calls.length, 0);
        assertEqual(h.controls.withdrawSteeringRequest.mock.calls.length, 0);
    });

    it("ST-A05: read shares can inspect receipts, but private outsiders cannot", async () => {
        const readable = makeRuntime({ share: "read" });
        const params = { sessionId: "steer-session", requestId: "request-a" };
        expect(await readable.runtime.call("getSteeringRequest", params, as("bob"))).toEqual(receipt());
        const hidden = makeRuntime();
        await expect(hidden.runtime.call("getSteeringRequest", params, as("bob"))).rejects.toMatchObject({ status: 404 });
        assertEqual(hidden.controls.getSteeringRequest.mock.calls.length, 0);
    });
});
