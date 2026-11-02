/**
 * Where the new compute paths meet the failure classifier
 * (docs/proposals/compute-providers.md, "Failures and their reasons").
 *
 * A failure raised deep in the compute work — in the handshake, in the
 * bridge, in the adapter that talks to a provider service — has to arrive
 * at the orchestration as the one line the classifier reads, after
 * crossing the activity boundary, which carries only a string. These hold
 * that seam: one failure that retrying cannot help, and one that it can.
 *
 * Run: npx vitest run test/local/compute-failure-seam.test.js
 */
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createServer } from "node:net";
import { serveComputeProvider } from "../../src/compute-service.ts";
import { classifyComputeFailure } from "../../src/compute-failures.ts";
import { newComputeHandshakeSecret } from "../../src/compute-handshake.ts";
import { startComputeHost } from "../../src/compute-host.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

const CREDENTIAL = "a-credential-the-deployment-mints";
const computeServiceCredentials = async () => ({ headers: { "x-pilotswarm-credential": CREDENTIAL } });
const recognizesPilotSwarm = (headers) => headers["x-pilotswarm-credential"] === CREDENTIAL;

async function withCatalog(env, fn) {
    const catalog = await createCatalog(env);
    try {
        return await fn(catalog);
    } finally {
        await catalog.close?.();
    }
}

/**
 * A host that answers the handshake, in front of a stand-in for a runtime.
 *
 * The runtime itself never matters here: the worker must refuse the host
 * before a byte of the turn reaches it. Keeping a real agent runtime out
 * of these tests makes them say exactly one thing, and say it quickly.
 */
async function hostThatProvesItself(secret) {
    const runtime = createServer((socket) => socket.on("error", () => { /* closed by the test */ }));
    await new Promise((resolve) => runtime.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const bindingId = "a-binding-of-its-own";
    const component = await startComputeHost({
        bindingId, secret,
        listen: { host: "127.0.0.1", port: 0 },
        runtimeAddress: `127.0.0.1:${runtime.address().port}`,
        handshakeTimeoutMs: 5_000,
    });
    return {
        bindingId,
        address: component.address,
        async close() {
            await component.close();
            await new Promise((resolve) => runtime.close(resolve));
        },
    };
}

/** A provider whose hosts are that component, reached with whatever secret. */
function providerReaching(host, secret) {
    return {
        kind: "stub-kind",
        capabilities: { os: ["linux"], sandboxed: true, files: "none" },
        async bind() {
            return { ok: true, host: { kind: "stub-kind", id: "the-host", incarnation: "one" } };
        },
        async connect() {
            return {
                ok: true,
                endpoint: {
                    transport: "uri", address: host.address, connectionToken: "unused",
                    handshake: { bindingId: host.bindingId, secret },
                },
                workspace: {},
            };
        },
    };
}

/** What the orchestration recorded about the turn, as the client sees it. */
async function turnStatus(client, sessionId) {
    const status = await client._getDuroxideClient().getStatus(`session-${sessionId}`);
    return JSON.parse(status.customStatus ?? "{}");
}

describe("compute failures from the new paths reach the orchestration classified", () => {
    it("a host that cannot prove itself stops the turn at once, and is permanent", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const host = await hostThatProvesItself(newComputeHandshakeSecret());
        // A service that hands the worker a secret its host does not hold.
        const service = await serveComputeProvider(
            providerReaching(host, "0".repeat(64)), { auth: recognizesPilotSwarm });
        try {
            await withCatalog(env, async (catalog) => {
                await catalog.computeServices.create({
                    name: "seam-handshake", baseUrl: service.baseUrl,
                    serverName: "seam-handshake.example.invalid",
                }, null, true);
                await catalog.computeTargets.create(
                    { name: "shared/seam-handshake", kind: "stub-kind", class: "shared" }, null, true);
            });

            await withScriptedModel(env, {
                respond: () => ({ content: "must not run" }),
                worker: { computeServiceCredentials },
            }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({ model: qualifiedModel, computeTarget: "shared/seam-handshake" });
                const start = Date.now();
                const failure = await session.sendAndWait("run on a host that cannot prove itself", 30_000).catch((error) => error);

                // The reason reached the person, and it is the classifier's.
                expect(failure.message).toMatch(/COMPUTE_HANDSHAKE_FAILED/);
                expect(failure.message).toMatch(/could not verify the compute host/);
                // Permanent: it stopped rather than retrying to a timeout.
                expect(Date.now() - start).toBeLessThan(28_000);
                expect(model.sessionRequests(), "nothing of the turn crossed").toHaveLength(0);
                expect((await turnStatus(client, session.sessionId)).computeFailure)
                    .toEqual({ code: "COMPUTE_HANDSHAKE_FAILED", permanent: true });

                // And the session is ready for the next prompt, not stuck.
                const info = await session.getInfo();
                expect(info.error).toMatch(/could not verify the compute host/);
            });
        } finally {
            await service.close();
            await host.close();
        }
    });

    it("a provider service that is not answering is temporary, and is retried", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        // Registered, but nothing listens there: the service has gone away.
        await withCatalog(env, async (catalog) => {
            await catalog.computeServices.create({
                name: "seam-gone", baseUrl: "http://127.0.0.1:1",
                serverName: "seam-gone.example.invalid",
            }, null, true);
            // What it last said it served, so a turn can name the reason
            // rather than only "this worker has no provider of that kind".
            const [registered] = (await catalog.computeServices.list(true)).filter((s) => s.name === "seam-gone");
            await catalog.computeServices.recordDescription(registered.id, {
                protocolVersion: 1, kinds: ["gone-kind"], transport: "direct",
                capabilities: { os: ["linux"], sandboxed: true, files: "none" },
            });
            await catalog.computeTargets.create(
                { name: "shared/seam-gone", kind: "gone-kind", class: "shared" }, null, true);
        });

        await withScriptedModel(env, {
            respond: () => ({ content: "must not run" }),
            worker: { computeServiceCredentials },
        }, async ({ client, worker, model, qualifiedModel }) => {
            const preparations = vi.spyOn(worker.sessionManager, "_prepareCompute");
            const session = await client.createSession({ model: qualifiedModel, computeTarget: "shared/seam-gone" });
            await session.send("run on a service that has gone away");

            // Temporary, so the turn is tried again on today's schedule
            // rather than being ended the way a permanent one is.
            const attempts = () => preparations.mock.calls.filter(([id]) => id === session.sessionId).length;
            for (let i = 0; i < 60 && attempts() < 2; i++) {
                await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
            expect(attempts(), "a temporary failure keeps today's retries").toBeGreaterThanOrEqual(2);

            // The turn is not ended, so nothing is projected as a stop:
            // the kind is carried only for a permanent failure.
            expect((await turnStatus(client, session.sessionId)).computeFailure).toBeUndefined();

            // But the reason the person sees is the classifier's, not a raw one.
            const said = JSON.stringify(await withCatalog(env,
                (catalog) => catalog.getSessionEvents(session.sessionId, 0, 200)));
            expect(said).toMatch(/COMPUTE_SERVICE_UNAVAILABLE/);
            expect(said).toMatch(/temporarily unreachable/);
            expect(said).toMatch(/seam-gone/);
            expect(model.sessionRequests()).toHaveLength(0);
            preparations.mockRestore();
        });
    });

    it("the classifier reads a compute failure through the activity envelope it arrives in", () => {
        // What the runtime wraps a rejected activity in. The classifier has
        // to see through it, or every compute failure would read as prose.
        const wrapped = "Activity 'runTurn' JS execution failed: attempt 1, Error: COMPUTE_HANDSHAKE_FAILED: the host did not prove itself";
        const classified = classifyComputeFailure(wrapped);
        expect(classified.code).toBe("COMPUTE_HANDSHAKE_FAILED");
        expect(classified.permanent).toBe(true);

        // A provider's own code keeps the kind it declared, through the envelope.
        const own = classifyComputeFailure(
            "Activity 'runTurn' JS execution failed: attempt 1, Error: ACME_QUOTA_SPENT: [permanent] no capacity left");
        expect(own).toMatchObject({ code: "ACME_QUOTA_SPENT", permanent: true });
        const temporary = classifyComputeFailure("ACME_WARMING_UP: [temporary] the pool is still filling");
        expect(temporary).toMatchObject({ code: "ACME_WARMING_UP", permanent: false });

        // Ordinary prose is not a compute failure.
        expect(classifyComputeFailure("something went wrong")).toBeNull();
    });
});
