/**
 * Session turn control: management client Stop and Steer (design 4.3, plan C1).
 *
 * Part 1 uses a fake session catalog: every refusal, the accepted paths,
 * the Stop outcome wait and its timeout, the legacy fallback, the steering
 * flag for the caller's viewer, and the detailed-view fields in direct and
 * Web API mode (the Web API side runs the real portal runtime and HTTP
 * router over the same fake catalog, so the caller stamping is real).
 *
 * Part 2 runs against real PostgreSQL with the turn-control procedures
 * (migration 0082) and the portal runtime with ownership enforced.
 *
 * Run: npx vitest run test/local/turn-control-management.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { join } from "node:path";
import { PilotSwarmManagementClient } from "../../src/management-client.js";
import { TurnControlUnavailableError, TURN_CONTROL_EVENT_TYPES } from "../../src/turn-control-contract.js";
import { FEATURE_FLAGS } from "../../src/feature-flags.js";
import { stopTurnQueueName } from "../../src/types.js";
import { PortalRuntime } from "../../../app/web/runtime.js";
import { createApiRouter } from "../../../app/web/api/router.js";
import { NodeSdkTransport } from "../../../app/tui/src/node-sdk-transport.js";
import { createTestEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";

const STEERING = "sessions.steering";
const ALICE = { provider: "test", subject: "alice", displayName: "Alice" };
const BOB = { provider: "test", subject: "bob", displayName: "Bob" };

// ─── Fakes ───────────────────────────────────────────────────────

function steeringSnapshot({ cluster, users = [] } = {}) {
    const definition = { featureKey: STEERING, ...FEATURE_FLAGS[STEERING], revision: "1" };
    const settings = [];
    if (cluster) {
        settings.push({ settingId: "c", featureKey: STEERING, scope: "cluster", userId: null, enabled: cluster.enabled,
            allowUserOverride: cluster.allowUserOverride, revision: "1", updatedBy: "admin", updatedAt: "2026-10-13T00:00:00Z" });
    }
    users.forEach((user, index) => {
        settings.push({ settingId: `u${index}`, featureKey: STEERING, scope: "user", userId: index + 1, enabled: user.enabled,
            allowUserOverride: null, revision: "1", updatedBy: user.owner.subject, updatedAt: "2026-10-13T00:00:00Z",
            owner: { provider: user.owner.provider, subject: user.owner.subject } });
    });
    return { definitions: [definition], settings };
}

/**
 * A fake session catalog. `add` answers turnControlAdd; `outcomes` maps a
 * control seq to the outcome event that appears after `appearAfterPolls`
 * outcome reads.
 */
function createFakeCatalog({ row = null, add = () => ({ seq: 41, turn: 3 }), outcomes = {}, appearAfterPolls = 0, flag = { cluster: { enabled: true, allowUserOverride: false } }, features = true } = {}) {
    const calls = { add: [], eventReads: [], enqueues: [] };
    let outcomeReads = 0;
    const catalog = {
        getSession: async () => row,
        updateSession: async () => {},
        getSessionAccess: async (sessionId, viewer) => ({
            sessionId, rootSessionId: sessionId, visibility: "private", viewerShareAccess: null,
            viewerIsOwner: viewer?.subject === ALICE.subject,
        }),
        turnControlAdd: async (sessionId, kind, text, requestId, actor) => {
            calls.add.push({ sessionId, kind, text, requestId, actor });
            const answer = typeof add === "function" ? add({ sessionId, kind, text, requestId, actor }) : add;
            if (answer instanceof Error) throw answer;
            return answer;
        },
        getSessionEvents: async (sessionId, afterSeq, limit, types) => {
            calls.eventReads.push({ sessionId, afterSeq, limit, types });
            outcomeReads += 1;
            if (outcomeReads <= appearAfterPolls) return [];
            return Object.entries(outcomes)
                .map(([seq, outcome], index) => ({
                    seq: 1000 + index, sessionId, eventType: TURN_CONTROL_EVENT_TYPES.outcome,
                    data: { seq: Number(seq), turn: 3, outcome }, createdAt: new Date(),
                }))
                .filter((event) => event.seq > afterSeq);
        },
        ...(features ? { features: { snapshot: async (keys) => { expect(keys).toEqual([STEERING]); return steeringSnapshot(flag); } } } : {}),
    };
    return { catalog, calls };
}

function createMgmt(fake, { response } = {}) {
    const mgmt = new PilotSwarmManagementClient({});
    mgmt._started = true;
    mgmt._catalog = fake.catalog;
    mgmt._duroxideClient = {
        enqueueEvent: async (orchestrationId, queue, payload) => {
            fake.calls.enqueues.push({ orchestrationId, queue, payload: JSON.parse(payload) });
        },
        getInstanceInfo: async () => ({ status: "Running", orchestrationVersion: "1.0.81" }),
        getStatus: async () => ({ status: "Running", customStatusVersion: 7, customStatus: JSON.stringify({ status: "running", iteration: 2 }) }),
    };
    mgmt._assertOrchestrationLive = async () => {};
    mgmt._readJsonValue = async (_sessionId, key) => {
        const first = fake.calls.enqueues[0];
        if (response && first && key === `command.response.${first.payload.id}`) {
            return { schemaVersion: 1, version: 1, emittedAt: Date.now(), id: first.payload.id, cmd: "stop_turn", ...response };
        }
        return null;
    };
    return mgmt;
}

function sessionRow(overrides = {}) {
    return {
        sessionId: "s1", state: "running", activeTurnIndex: 3, turnHigh: 3, deletedAt: null,
        createdAt: new Date("2026-10-13T00:00:00Z"), updatedAt: new Date("2026-10-13T00:01:00Z"),
        title: "t", owner: null, parentSessionId: null, isSystem: false, currentIteration: 2,
        lastError: null, waitReason: null, model: "m", groupId: null, visibility: "private",
        rootSessionId: "s1",
        ...overrides,
    };
}

/** Web API mode over the same management client: real runtime, router and Node transport. */
async function startWebHarness(mgmt, { principal = ALICE, role = "user" } = {}) {
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.authz = { ...runtime.authz, enforce: false };
    runtime.start = async () => {};
    const transport = Object.create(NodeSdkTransport.prototype);
    transport.mgmt = mgmt;
    runtime.transport = transport;
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/v1", createApiRouter({ runtime, requireAuth: (req, _res, next) => {
        req.auth = { principal, authorization: { role, allowed: true } };
        next();
    } }));
    const server = await new Promise((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const apiUrl = `http://127.0.0.1:${server.address().port}`;
    const web = new PilotSwarmManagementClient({ apiUrl });
    return { web, apiUrl, close: () => new Promise((resolve) => server.close(resolve)) };
}

// ─── Part 1: fake catalog ────────────────────────────────────────

describe("steerSessionTurn (fake catalog)", () => {
    it("accepts a steer: the text and request id pass unchanged, the actor is the normalized sender", async () => {
        const fake = createFakeCatalog({ add: { seq: 41, turn: 3 } });
        const mgmt = createMgmt(fake);
        const sender = { kind: "user", provider: "test", subject: "alice", display: "Alice", relation: "owner", origin: "portal", junk: "x" };
        const result = await mgmt.steerSessionTurn("s1", { text: "  use metric units  ", requestId: "req-1", caller: { sender } });
        expect(result).toEqual({ outcome: "accepted", steerId: 41, turn: 3 });
        expect(fake.calls.add).toEqual([{ sessionId: "s1", kind: "steer", text: "  use metric units  ", requestId: "req-1",
            actor: { kind: "user", provider: "test", subject: "alice", display: "Alice", relation: "owner", origin: "portal" } }]);
    });

    it("passes a repeat answer through and records a null actor without a sender", async () => {
        const fake = createFakeCatalog({ add: { seq: 41, turn: 3, repeat: true } });
        const result = await createMgmt(fake).steerSessionTurn("s1", { text: "again", requestId: "req-1" });
        expect(result).toEqual({ outcome: "accepted", steerId: 41, turn: 3, repeat: true });
        expect(fake.calls.add[0].actor).toBeNull();
    });

    for (const refusal of ["no_turn", "legacy_turn", "not_found", "too_many", "request_id_reused"]) {
        it(`maps the refusal ${refusal}`, async () => {
            const fake = createFakeCatalog({ add: { refused: refusal } });
            expect(await createMgmt(fake).steerSessionTurn("s1", { text: "x", requestId: `r-${refusal}` })).toEqual({ outcome: refusal });
        });
    }

    it("answers legacy_turn when the catalog has no turn-control procedures", async () => {
        const fake = createFakeCatalog({ add: new TurnControlUnavailableError("turnControlAdd") });
        expect(await createMgmt(fake).steerSessionTurn("s1", { text: "x", requestId: "r" })).toEqual({ outcome: "legacy_turn" });
    });

    it("refuses with steering_disabled and records nothing when the flag is off", async () => {
        for (const flag of [{}, { cluster: { enabled: false, allowUserOverride: false } }]) {
            const fake = createFakeCatalog({ flag });
            expect(await createMgmt(fake).steerSessionTurn("s1", { text: "x", requestId: "r" })).toEqual({ outcome: "steering_disabled" });
            expect(fake.calls.add).toHaveLength(0);
        }
        const fake = createFakeCatalog({ features: false });
        expect(await createMgmt(fake).steerSessionTurn("s1", { text: "x", requestId: "r" })).toEqual({ outcome: "steering_disabled" });
        expect(fake.calls.add).toHaveLength(0);
    });

    it("the flag defaults to off with no user override", () => {
        expect(FEATURE_FLAGS[STEERING]).toMatchObject({ defaultEnabled: false, defaultAllowUserOverride: false });
    });

    it("resolves the flag for the caller's viewer: an owner override applies to the owner, not to a collaborator", async () => {
        const flag = { cluster: { enabled: false, allowUserOverride: true }, users: [{ owner: ALICE, enabled: true }] };
        const alice = await createMgmt(createFakeCatalog({ flag })).steerSessionTurn("s1", { text: "x", requestId: "a", caller: { viewer: { principal: ALICE, isAdmin: false } } });
        expect(alice.outcome).toBe("accepted");
        const bob = await createMgmt(createFakeCatalog({ flag })).steerSessionTurn("s1", { text: "x", requestId: "b", caller: { viewer: { principal: BOB, isAdmin: false } } });
        expect(bob).toEqual({ outcome: "steering_disabled" });
        const cluster = await createMgmt(createFakeCatalog({ flag })).steerSessionTurn("s1", { text: "x", requestId: "c" });
        expect(cluster).toEqual({ outcome: "steering_disabled" });
    });

    it("ignores a user override that the operator does not allow", async () => {
        const flag = { cluster: { enabled: false, allowUserOverride: false }, users: [{ owner: ALICE, enabled: true }] };
        const result = await createMgmt(createFakeCatalog({ flag })).steerSessionTurn("s1", { text: "x", requestId: "a", caller: { viewer: { principal: ALICE, isAdmin: false } } });
        expect(result).toEqual({ outcome: "steering_disabled" });
    });

    it("rejects empty text and a missing or invalid request id before recording", async () => {
        const fake = createFakeCatalog();
        const mgmt = createMgmt(fake);
        await expect(mgmt.steerSessionTurn("s1", { text: "   ", requestId: "r" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        await expect(mgmt.steerSessionTurn("s1", { text: "x" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        await expect(mgmt.steerSessionTurn("s1", { text: "x", requestId: "r".repeat(201) })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        expect(fake.calls.add).toHaveLength(0);
    });
});

describe("stopSessionTurn (fake catalog)", () => {
    it("records a Stop and waits for the stopped outcome", async () => {
        const fake = createFakeCatalog({ add: { seq: 50, turn: 3 }, outcomes: { 50: "stopped" }, appearAfterPolls: 2 });
        const sender = { kind: "user", provider: "test", subject: "bob", relation: "collaborator" };
        const result = await createMgmt(fake).stopSessionTurn("s1", { requestId: "stop-1", caller: { sender } });
        expect(result).toEqual({ outcome: "stopped", turnIndex: 3, controlSeq: 50 });
        expect(fake.calls.add).toEqual([{ sessionId: "s1", kind: "stop", text: "Stopped by user", requestId: "stop-1",
            actor: { kind: "user", provider: "test", subject: "bob", relation: "collaborator" } }]);
        expect(fake.calls.eventReads.length).toBe(3);
        expect(fake.calls.eventReads.every((read) => read.afterSeq === 50 && read.types.length === 1
            && read.types[0] === "session.control_outcome")).toBe(true);
        expect(fake.calls.enqueues).toHaveLength(0);
    });

    it("returns too_late, and ignores outcomes of other controls", async () => {
        const fake = createFakeCatalog({ add: { seq: 50, turn: 3 }, outcomes: { 49: "delivered", 50: "too_late" } });
        expect(await createMgmt(fake).stopSessionTurn("s1", { reason: "enough" })).toEqual({ outcome: "too_late", turnIndex: 3, controlSeq: 50 });
        expect(fake.calls.add[0].text).toBe("enough");
    });

    it("reports a failed outcome read instead of a timeout", async () => {
        const fake = createFakeCatalog({ add: { seq: 50, turn: 3 } });
        fake.catalog.getSessionEvents = async () => { throw new Error("outcome read failed: connection reset"); };
        await expect(createMgmt(fake).stopSessionTurn("s1", { requestId: "stop-r" })).rejects.toThrow(/outcome read failed/);
        expect(fake.calls.add).toHaveLength(1);
    });

    it("rejects an invalid timeout before recording anything; accepts the default, zero and a positive value", async () => {
        for (const timeoutMs of ["not-a-number", { ms: 5 }, Number.NaN, Number.POSITIVE_INFINITY, -1, 300_001]) {
            const fake = createFakeCatalog({ add: { seq: 50, turn: 3 }, outcomes: { 50: "stopped" } });
            await expect(createMgmt(fake).stopSessionTurn("s1", { timeoutMs })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
            expect(fake.calls.add).toHaveLength(0);
        }
        for (const timeoutMs of [undefined, 0, 1_000]) {
            const fake = createFakeCatalog({ add: { seq: 50, turn: 3 }, outcomes: { 50: "stopped" } });
            expect((await createMgmt(fake).stopSessionTurn("s1", { timeoutMs })).outcome).toBe("stopped");
        }
        const zero = createFakeCatalog({ add: { seq: 51, turn: 3 } });
        expect(await createMgmt(zero).stopSessionTurn("s1", { timeoutMs: 0 })).toMatchObject({ outcome: "timeout", controlSeq: 51 });
        expect(zero.calls.eventReads).toHaveLength(1);
    });

    it("generates a request id when none is given", async () => {
        const fake = createFakeCatalog({ add: { seq: 50, turn: 3 }, outcomes: { 50: "stopped" } });
        await createMgmt(fake).stopSessionTurn("s1");
        expect(typeof fake.calls.add[0].requestId).toBe("string");
        expect(fake.calls.add[0].requestId.length).toBeGreaterThan(0);
    });

    it("times out with the control seq when the accepted Stop has no outcome yet", async () => {
        const fake = createFakeCatalog({ add: { seq: 50, turn: 3 } });
        const started = Date.now();
        const result = await createMgmt(fake).stopSessionTurn("s1", { timeoutMs: 600 });
        expect(result).toMatchObject({ outcome: "timeout", turnIndex: 3, controlSeq: 50 });
        expect(Date.now() - started).toBeGreaterThanOrEqual(600);
        expect(fake.calls.eventReads.length).toBeGreaterThanOrEqual(2);
    });

    it("answers no_active_turn on no_turn and names any other refusal", async () => {
        expect(await createMgmt(createFakeCatalog({ add: { refused: "no_turn" } })).stopSessionTurn("s1"))
            .toMatchObject({ outcome: "no_active_turn" });
        for (const refusal of ["not_found", "too_many", "request_id_reused"]) {
            expect(await createMgmt(createFakeCatalog({ add: { refused: refusal } })).stopSessionTurn("s1"))
                .toEqual({ outcome: "no_active_turn", detail: refusal });
        }
    });

    it("takes the legacy event path on legacy_turn", async () => {
        const fake = createFakeCatalog({
            add: { refused: "legacy_turn" },
            row: sessionRow({ activeTurnIndex: 4, turnHigh: -1 }),
        });
        const result = await createMgmt(fake, { response: { result: { outcome: "stop_forced", turnIndex: 4 } } })
            .stopSessionTurn("s1", { reason: "legacy stop" });
        expect(result).toEqual({ outcome: "stop_forced", turnIndex: 4 });
        expect(fake.calls.enqueues).toHaveLength(1);
        expect(fake.calls.enqueues[0].queue).toBe(stopTurnQueueName(4));
        expect(fake.calls.enqueues[0].payload.reason).toBe("legacy stop");
    });

    it("takes the legacy path when the catalog has no turn-control procedures", async () => {
        const fake = createFakeCatalog({
            add: new TurnControlUnavailableError("turnControlAdd"),
            row: sessionRow({ activeTurnIndex: 2, turnHigh: null }),
        });
        const result = await createMgmt(fake, { response: { result: { outcome: "stopped", turnIndex: 2 } } }).stopSessionTurn("s1");
        expect(result).toEqual({ outcome: "stopped", turnIndex: 2 });
        expect(fake.calls.enqueues[0].queue).toBe("stopTurn.2");
    });

    it("is never gated by the steering flag, and keeps the actor", async () => {
        const fake = createFakeCatalog({ add: { seq: 50, turn: 3 }, outcomes: { 50: "stopped" }, flag: { cluster: { enabled: false, allowUserOverride: false } } });
        const sender = { kind: "user", provider: "test", subject: "alice" };
        expect((await createMgmt(fake).stopSessionTurn("s1", { caller: { sender, viewer: { principal: ALICE, isAdmin: false } } })).outcome).toBe("stopped");
        expect(fake.calls.add[0].actor).toEqual({ kind: "user", provider: "test", subject: "alice" });
    });
});

describe("detailed session view (fake catalog)", () => {
    const view = async (row) => createMgmt(createFakeCatalog({ row })).getSession(row.sessionId);

    it("accepts controls while a turn-control turn runs", async () => {
        expect(await view(sessionRow())).toMatchObject({ activeTurnIndex: 3, turnHigh: 3, acceptsTurnControl: true });
    });

    it("is false between turns, on a legacy turn and when the catalog does not report turnHigh", async () => {
        expect(await view(sessionRow({ state: "idle", activeTurnIndex: null }))).toMatchObject({ activeTurnIndex: null, turnHigh: 3, acceptsTurnControl: false });
        expect(await view(sessionRow({ state: "waiting", activeTurnIndex: null }))).toMatchObject({ acceptsTurnControl: false });
        expect(await view(sessionRow({ activeTurnIndex: 4, turnHigh: 3 }))).toMatchObject({ activeTurnIndex: 4, turnHigh: 3, acceptsTurnControl: false });
        const legacy = await view(sessionRow({ activeTurnIndex: 4, turnHigh: undefined }));
        expect(legacy).toMatchObject({ activeTurnIndex: 4, turnHigh: null, acceptsTurnControl: false });
        expect(Object.hasOwn(legacy, "acceptsTurnControl")).toBe(true);
    });
});

describe("Web API mode (fake catalog, real runtime and router)", () => {
    it("returns the same detailed view as direct mode", async () => {
        const fake = createFakeCatalog({ row: sessionRow() });
        const mgmt = createMgmt(fake);
        const harness = await startWebHarness(mgmt);
        try {
            const direct = JSON.parse(JSON.stringify(await mgmt.getSession("s1")));
            const web = await harness.web.getSession("s1");
            expect(web).toEqual(direct);
            expect(web).toMatchObject({ activeTurnIndex: 3, turnHigh: 3, acceptsTurnControl: true });
            fake.catalog.getSession = async () => sessionRow({ state: "idle", activeTurnIndex: null });
            expect(await harness.web.getSession("s1")).toMatchObject({ activeTurnIndex: null, acceptsTurnControl: false });
        } finally {
            await harness.close();
        }
    });

    it("overwrites a forged caller with the authenticated sender and viewer", async () => {
        const flag = { cluster: { enabled: false, allowUserOverride: true }, users: [{ owner: BOB, enabled: true }] };
        const fake = createFakeCatalog({ flag, add: { seq: 60, turn: 3 }, outcomes: { 61: "stopped" } });
        const harness = await startWebHarness(createMgmt(fake), { principal: ALICE });
        try {
            const forged = {
                sender: { kind: "user", provider: "test", subject: "bob", display: "Bob", relation: "owner" },
                viewer: { principal: BOB, isAdmin: true },
            };
            // Bob's override would enable Steer; the server resolves the flag for Alice.
            expect(await harness.web.steerSessionTurn("s1", { text: "x", requestId: "r1", caller: forged })).toEqual({ outcome: "steering_disabled" });
            expect(fake.calls.add).toHaveLength(0);

            fake.catalog.turnControlAdd = async (sessionId, kind, text, requestId, actor) => {
                fake.calls.add.push({ sessionId, kind, text, requestId, actor });
                return { seq: 61, turn: 3 };
            };
            const stop = await harness.web.stopSessionTurn("s1", { requestId: "stop-9", caller: forged, origin: "portal" });
            expect(stop).toEqual({ outcome: "stopped", turnIndex: 3, controlSeq: 61 });
            expect(fake.calls.add[0]).toMatchObject({ kind: "stop", requestId: "stop-9", text: "Stopped by user" });
            expect(fake.calls.add[0].actor).toMatchObject({ kind: "user", provider: "test", subject: "alice", display: "Alice", origin: "portal" });
        } finally {
            await harness.close();
        }
    });

    it("Web API: an invalid Stop timeout is a 400 and records nothing; a failed outcome read is an error", async () => {
        const fake = createFakeCatalog({ add: { seq: 70, turn: 3 } });
        const harness = await startWebHarness(createMgmt(fake));
        try {
            for (const timeoutMs of ["not-a-number", { ms: 5 }]) {
                const response = await fetch(`${harness.apiUrl}/api/v1/management/sessions/s1/stop-turn`, {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ options: { timeoutMs, requestId: "r" } }),
                });
                expect(response.status).toBe(400);
                expect((await response.json()).error.code).toBe("INVALID_REQUEST");
            }
            expect(fake.calls.add).toHaveLength(0);
            fake.catalog.getSessionEvents = async () => { throw new Error("outcome read failed"); };
            await expect(harness.web.stopSessionTurn("s1", { requestId: "r-read" })).rejects.toMatchObject({ status: 500 });
            expect(fake.calls.add).toHaveLength(1);
        } finally {
            await harness.close();
        }
    });

    it("forwards steer options unchanged and maps the same answers as direct mode", async () => {
        const flag = { cluster: { enabled: true, allowUserOverride: false } };
        const fake = createFakeCatalog({ flag, add: ({ requestId }) => (requestId === "dup" ? { seq: 7, turn: 3, repeat: true } : { refused: "no_turn" }) });
        const mgmt = createMgmt(fake);
        const harness = await startWebHarness(mgmt);
        try {
            for (const requestId of ["dup", "new"]) {
                const viaWeb = await harness.web.steerSessionTurn("s1", { text: "go", requestId });
                const viaDirect = await mgmt.steerSessionTurn("s1", { text: "go", requestId });
                expect(viaWeb).toEqual(viaDirect);
            }
            expect(fake.calls.add.map((call) => call.requestId)).toEqual(["dup", "dup", "new", "new"]);
            expect(fake.calls.add[0].text).toBe("go");
        } finally {
            await harness.close();
        }
    });
});

// ─── Part 2: real PostgreSQL ─────────────────────────────────────

const READER = { provider: "test", subject: "reader", displayName: "Reader" };
const authOf = (principal, role = "user") => ({ principal, authorization: { role, allowed: true } });

describe("turn control against real PostgreSQL", () => {
    let env, runtime, catalog, mgmt;
    const saved = {};
    const setEnv = (key, value) => {
        saved[key] = process.env[key];
        if (value == null) delete process.env[key]; else process.env[key] = value;
    };
    const countEvents = async (sessionId, type) => (await catalog.getSessionEvents(sessionId, 0, 1000, [type])).length;

    beforeAll(async () => {
        env = createTestEnv("turn_control_mgmt");
        for (const [key, value] of Object.entries({
            PILOTSWARM_CMS_SCHEMA: env.cmsSchema, PILOTSWARM_DUROXIDE_SCHEMA: env.duroxideSchema,
            PILOTSWARM_FACTS_SCHEMA: env.factsSchema, HORIZON_FACTS_SCHEMA: env.factsSchema,
            ARTIFACT_DIR: join(env.baseDir, "artifacts"), AZURE_STORAGE_CONNECTION_STRING: null, AZURE_STORAGE_ACCOUNT_URL: null,
        })) setEnv(key, value);
        runtime = new PortalRuntime({ store: env.store, mode: "remote" });
        runtime.authz = { adminScope: "cluster", enforce: true, defaultVisibility: "private", systemVisibility: "admin" };
        await runtime.transport.mgmt.start();
        runtime.started = true;
        mgmt = runtime.transport.mgmt;
        catalog = mgmt._catalog;
        const admin = { principal: { provider: "test", subject: "admin" }, isAdmin: true };
        const view = await catalog.features.read(admin, "cluster");
        const revision = view.flags.find((flag) => flag.featureKey === STEERING).revision;
        await catalog.features.mutate(admin, "cluster", { featureKey: STEERING, expectedRevision: revision, requestId: `enable-${env.cmsSchema}`, enabled: true, allowUserOverride: false });
    }, 180_000);

    afterAll(async () => {
        try { await mgmt?.stop(); }
        finally {
            await env?.cleanup();
            for (const [key, value] of Object.entries(saved)) {
                if (value == null) delete process.env[key]; else process.env[key] = value;
            }
        }
    }, 180_000);

    async function runningSession(sessionId, opts = {}) {
        await catalog.createSession(sessionId, { model: "test:model", owner: ALICE, ...opts });
        const started = await catalog.turnStart(sessionId, 0);
        expect(started).toEqual({ stopped: false, controls: [] });
        return sessionId;
    }

    it("records an accepted steer once, attributed to the authenticated caller", async () => {
        const sessionId = await runningSession("tc-steer-once");
        const answer = await runtime.call("steerSessionTurn", { sessionId, options: { text: "use metric", requestId: "r-1" } }, authOf(ALICE));
        expect(answer).toMatchObject({ outcome: "accepted", turn: 0 });
        const events = await catalog.getSessionEvents(sessionId, 0, 100, [TURN_CONTROL_EVENT_TYPES.steer]);
        expect(events).toHaveLength(1);
        expect(events[0].seq).toBe(answer.steerId);
        expect(events[0].data).toMatchObject({ turn: 0, text: "use metric", requestId: "r-1", actor: { kind: "user", provider: "test", subject: "alice" } });
        expect(await mgmt.getSession(sessionId)).toMatchObject({ activeTurnIndex: 0, turnHigh: 0, acceptsTurnControl: true });
    });

    it("returns the original answer to a same-id retry after the turn ended, with one control event", async () => {
        const sessionId = await runningSession("tc-lost-response");
        const first = await mgmt.steerSessionTurn(sessionId, { text: "lost answer", requestId: "r-lost" });
        expect(first).toMatchObject({ outcome: "accepted", turn: 0 });
        await catalog.turnEnd(sessionId, 0, first.steerId, "other", []);
        expect(await mgmt.getSession(sessionId)).toMatchObject({ activeTurnIndex: null, acceptsTurnControl: false });
        const retry = await mgmt.steerSessionTurn(sessionId, { text: "lost answer", requestId: "r-lost" });
        expect(retry).toEqual({ outcome: "accepted", steerId: first.steerId, turn: 0, repeat: true });
        expect(await countEvents(sessionId, TURN_CONTROL_EVENT_TYPES.steer)).toBe(1);
        expect(await mgmt.steerSessionTurn(sessionId, { text: "other text", requestId: "r-lost" })).toEqual({ outcome: "request_id_reused" });
        expect(await mgmt.steerSessionTurn(sessionId, { text: "new", requestId: "r-new" })).toEqual({ outcome: "no_turn" });
        expect(await countEvents(sessionId, TURN_CONTROL_EVENT_TYPES.steer)).toBe(1);
    });

    it("records a Stop and returns its outcome once turn end writes it", async () => {
        const sessionId = await runningSession("tc-stop");
        const pending = mgmt.stopSessionTurn(sessionId, { requestId: "s-1", caller: { sender: { kind: "user", provider: "test", subject: "alice" } } });
        // Observe the pending Stop at once, so a failing assertion below
        // never leaves an unhandled rejection behind.
        const settled = pending.then((value) => ({ value }), (error) => ({ error }));
        let stops = [];
        for (let i = 0; i < 40 && stops.length === 0; i += 1) {
            stops = await catalog.getSessionEvents(sessionId, 0, 10, [TURN_CONTROL_EVENT_TYPES.stop]);
            if (stops.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        try {
            expect(stops).toHaveLength(1);
            await catalog.turnEnd(sessionId, 0, 0, "stopped", []);
        } finally {
            const result = await settled;
            if (result.error) throw result.error;
            expect(result.value).toEqual({ outcome: "stopped", turnIndex: 0, controlSeq: stops[0]?.seq });
        }
        expect(await mgmt.stopSessionTurn(sessionId, { requestId: "s-2" })).toMatchObject({ outcome: "no_active_turn" });
        expect(await countEvents(sessionId, TURN_CONTROL_EVENT_TYPES.stop)).toBe(1);
    });

    it("refuses a read-only collaborator with 403 and records nothing; a write share may steer", async () => {
        const sessionId = await runningSession("tc-readonly");
        await catalog.grantSessionShare(sessionId, READER, "read", ALICE);
        await expect(runtime.call("steerSessionTurn", { sessionId, options: { text: "x", requestId: "ro-1" } }, authOf(READER)))
            .rejects.toMatchObject({ status: 403 });
        await expect(runtime.call("stopSessionTurn", { sessionId, options: { requestId: "ro-2" } }, authOf(READER)))
            .rejects.toMatchObject({ status: 403 });
        expect(await countEvents(sessionId, TURN_CONTROL_EVENT_TYPES.steer)).toBe(0);
        expect(await countEvents(sessionId, TURN_CONTROL_EVENT_TYPES.stop)).toBe(0);
        await catalog.grantSessionShare(sessionId, READER, "write", ALICE);
        const answer = await runtime.call("steerSessionTurn", { sessionId, options: { text: "x", requestId: "ro-3" } }, authOf(READER));
        expect(answer).toMatchObject({ outcome: "accepted" });
        const [event] = await catalog.getSessionEvents(sessionId, 0, 10, [TURN_CONTROL_EVENT_TYPES.steer]);
        expect(event.data.actor).toMatchObject({ subject: "reader", relation: "collaborator" });
    });

    it("delivers a no-turn steer once as an ordinary message", async () => {
        await withClient(env, async (client) => {
            const session = await client.createSession();
            await session.sendAndWait("Say hello.", 120_000);
            const text = "Steer fallback: answer with the word fallback.";
            expect(await mgmt.steerSessionTurn(session.sessionId, { text, requestId: "fb-1" })).toEqual({ outcome: "no_turn" });
            await session.sendAndWait(text, 120_000);
            const messages = (await catalog.getSessionEvents(session.sessionId, 0, 500, ["user.message"]))
                .filter((event) => event.data?.content === text || event.data?.prompt === text);
            expect(messages).toHaveLength(1);
            expect(await countEvents(session.sessionId, TURN_CONTROL_EVENT_TYPES.steer)).toBe(0);
        });
    }, 300_000);
});
