/**
 * The sessions.steering flag end to end through the real Web API (session
 * turn control, design 4.3 and 4.11).
 *
 * The real portal server (startServer: Express, /api/v1, dev sign-in) runs
 * against the test schema with no embedded workers; a real worker with the
 * scripted model runs the session's turns. A person's Steer and Stop, the
 * admin's cluster flag changes and the viewer's flag view all go through
 * HTTP with dev tokens, exactly as the portal sends them. The session's
 * turns block in a test tool, so a turn is running when the person acts.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForEventCount, waitForSessionState } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { defineTool } from "../helpers/local-workers.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 300_000;
const WAIT = 120_000;
const FLAG = "sessions.steering";
const ALICE = { provider: "dev", subject: "alice", email: "alice@dev.local", displayName: "Alice Anderson" };

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};

/** A tool that blocks each turn until the test releases it. */
function blockingTool() {
    let started = deferred();
    let released = deferred();
    return {
        get started() { return started.promise; },
        release() { released.resolve(); },
        rearm() { started = deferred(); released = deferred(); },
        tool: defineTool("tc_w_block", {
            description: "Wait for the test to release this step.",
            parameters: { type: "object", properties: {} },
            handler: async () => { started.resolve(); await released.promise; return "released"; },
        }),
    };
}

/** Each turn calls the blocking tool; the model follows a steer at its next call. */
function responder(_body, position) {
    if (position.lastUserText.includes("PTW-STEER")) return { content: "followed the steer" };
    if (position.step === 0) return { tools: [{ name: "tc_w_block", args: {} }] };
    return { content: "turn done" };
}

/** Set the env the portal server reads, and give a restore function. */
function portalEnv(env) {
    const values = {
        DATABASE_URL: env.store,
        PILOTSWARM_DUROXIDE_SCHEMA: env.duroxideSchema,
        PILOTSWARM_CMS_SCHEMA: env.cmsSchema,
        PILOTSWARM_FACTS_SCHEMA: env.factsSchema,
        PORTAL_TUI_MODE: "remote",
        WORKERS: "0",
        PORTAL_AUTH_PROVIDER: "dev",
        PORTAL_AUTH_DEV_ALLOW: "true",
        PORTAL_AUTH_DEV_USERS: "ada:admin,alice:user,bob:user",
        PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
        AUTHZ_ENFORCE_OWNERSHIP: "true",
    };
    const saved = {};
    for (const [key, value] of Object.entries(values)) { saved[key] = process.env[key]; process.env[key] = value; }
    for (const key of Object.keys(process.env).filter((k) => k.startsWith("PORTAL_AUTH_ENTRA_"))) { saved[key] = process.env[key]; delete process.env[key]; }
    return () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    };
}

/** An HTTP caller signed in as a dev persona: `call(method, path, body)` returns { status, body }. */
function persona(apiUrl, id) {
    return async (method, path, body) => {
        const response = await fetch(`${apiUrl}/api/v1${path}`, {
            method,
            headers: { authorization: `Bearer dev:${id}`, ...(body ? { "content-type": "application/json" } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
}

describe("turn control: the steering flag through the real Web API", () => {
    it("off by default, on and off by the admin, never by a user; Stop is never gated", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const block = blockingTool();
        await withScriptedModel(env, { tools: [block.tool], respond: responder }, async ({ client, model, qualifiedModel }) => {
            const restoreEnv = portalEnv(env);
            let catalog, server;
            try {
                catalog = await createCatalog(env);
                const { startServer } = await import("pilotswarm/web");
                server = await startServer({ port: 0 });
                const apiUrl = `http://127.0.0.1:${server.address().port}`;
                const ada = persona(apiUrl, "ada"), alice = persona(apiUrl, "alice");

                /** The viewer's flag view, as the portal reads it (case 5). */
                const myFlag = async (who) => {
                    const answer = await who("GET", "/management/users/me/features");
                    expect(answer).toMatchObject({ status: 200 });
                    return answer.body.result.flags.find((f) => f.featureKey === FLAG);
                };
                const setCluster = async (who, enabled) => {
                    const { revision } = await myFlag(who);
                    return who("PUT", `/management/features/cluster/${FLAG}`, {
                        enabled, allowUserOverride: false, expectedRevision: revision, requestId: randomUUID(),
                    });
                };
                const steer = (sessionId, text, requestId = randomUUID()) =>
                    alice("POST", `/management/sessions/${sessionId}/steer`, { options: { text, requestId } });
                const steers = async (sessionId) => (await catalog.getSessionEvents(sessionId)).filter((e) => e.eventType === "user.steer");

                // Sign in as the portal does: the first authenticated request
                // records the user (asynchronously), then the flag view answers.
                for (const who of [ada, alice]) {
                    expect((await who("GET", "/me/profile")).status).toBe(200);
                    await expect.poll(async () => (await who("GET", "/management/users/me/features")).status, { timeout: 10_000 }).toBe(200);
                }

                const session = await client.createSession({ model: qualifiedModel, owner: ALICE, tools: [block.tool] });
                const sessionId = session.sessionId;

                // ── 1. Off by default: Steer refused and nothing recorded; Stop works.
                expect(await myFlag(alice)).toMatchObject({ effective: false });
                expect(await myFlag(ada)).toMatchObject({ effective: false });
                await session.send("PTW-FIRST blocking turn");
                await block.started;
                const offSteer = await steer(sessionId, "PTW-STEER while off");
                expect(offSteer).toEqual({ status: 200, body: { ok: true, result: { outcome: "steering_disabled" } } });
                expect(await steers(sessionId)).toEqual([]);

                // ── 4. A user cannot change the cluster flag, and with
                // allowUserOverride false a user preference does not enable it.
                expect((await setCluster(alice, true)).status).toBe(403);
                const pref = await alice("PUT", `/management/users/me/features/${FLAG}`, {
                    enabled: true, expectedRevision: (await myFlag(alice)).revision, requestId: randomUUID(),
                });
                expect(pref.status).toBe(200);
                expect(await myFlag(alice)).toMatchObject({ effective: false, userOverrideIgnored: true });
                expect((await steer(sessionId, "PTW-STEER with a user preference")).body.result).toEqual({ outcome: "steering_disabled" });
                expect(await steers(sessionId)).toEqual([]);

                const stop = await alice("POST", `/management/sessions/${sessionId}/stop-turn`, { options: { reason: "stop while steering is off" } });
                expect(stop.status).toBe(200);
                expect(stop.body.result).toMatchObject({ outcome: "stopped", controlSeq: expect.any(Number) });
                await waitForSessionState(catalog, sessionId, "idle", WAIT);
                block.release();

                // ── 2. The admin turns it on: the owner's steer is accepted and delivered.
                block.rearm();
                const on = await setCluster(ada, true);
                expect(on.status).toBe(200);
                expect(await myFlag(alice)).toMatchObject({ effective: true });
                expect(await myFlag(ada)).toMatchObject({ effective: true });
                await session.send("PTW-SECOND blocking turn");
                await block.started;
                const requestId = randomUUID();
                const accepted = await steer(sessionId, "PTW-STEER use metric units", requestId);
                expect(accepted.status).toBe(200);
                expect(accepted.body.result).toMatchObject({ outcome: "accepted", steerId: expect.any(Number), turn: expect.any(Number) });
                expect(accepted.body.result.repeat).toBeUndefined();
                const { steerId } = accepted.body.result;
                // The model reads the steer at its next call, after the tool.
                block.release();
                const [confirmed] = await waitForEventCount(catalog, sessionId, "session.steer_confirmed", 1, WAIT);
                expect(confirmed.data.seq).toBe(steerId);
                await waitForSessionState(catalog, sessionId, "idle", WAIT);
                // The state goes idle at the end-of-turn write; the outcome follows the save.
                const outcomes = () => catalog.getSessionEvents(sessionId)
                    .then((all) => all.filter((e) => e.eventType === "session.control_outcome" && e.data.seq === steerId).map((e) => e.data.outcome));
                await expect.poll(outcomes, { timeout: WAIT }).toEqual(["delivered"]);
                const recorded = await steers(sessionId);
                expect(recorded).toHaveLength(1);
                expect(recorded[0]).toMatchObject({ seq: steerId, data: { text: "PTW-STEER use metric units", requestId } });
                expect(recorded[0].data.actor).toMatchObject({ kind: "user", provider: "dev", subject: "alice" });
                const followed = model.requests.filter((r) => r.session && r.position.lastUserText.includes("PTW-STEER use metric units"));
                expect(followed.at(-1)?.answer).toEqual({ content: "followed the steer" });

                // ── 3. The admin turns it off again: a new request id is
                // refused; a retry of the accepted request id gets its first answer.
                expect((await setCluster(ada, false)).status).toBe(200);
                expect(await myFlag(alice)).toMatchObject({ effective: false });
                expect((await steer(sessionId, "PTW-STEER after off")).body.result).toEqual({ outcome: "steering_disabled" });
                const retry = await steer(sessionId, "PTW-STEER use metric units", requestId);
                expect(retry.body.result).toEqual({ outcome: "accepted", steerId, turn: accepted.body.result.turn, repeat: true });
                expect(await steers(sessionId)).toHaveLength(1);
            } finally {
                block.release();
                try {
                    await server?.stopPortal?.();
                    await catalog?.close();
                } finally {
                    restoreEnv();
                }
            }
        });
    });
});
