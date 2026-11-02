/**
 * A compute provider that runs outside the worker
 * (docs/proposals/compute-providers.md, "Provider services and
 * registration", "The handshake", "Host lifecycle").
 *
 * The other local compute tests drive providers the worker was built
 * with. This one drives the arrangement a real provider uses: an
 * administrator registers a provider service, and the worker reaches it
 * through the generic adapter, holding no rights of its own and knowing
 * nothing about what the service makes hosts out of.
 *
 * The service here serves the `process` provider, so there is a real
 * runtime at the far end and a whole turn can run through it — through
 * the registered service, over the protocol, through the bridge and
 * through the mutual handshake with the host component. A real service
 * would make hosts somewhere else; nothing on this path would change.
 *
 * It also holds the parts that only show up with a database behind them:
 * that a registered service is an administrator's business alone, that a
 * worker refuses a service whose identity does not match what was
 * registered, that a wrong handshake secret stops a turn before anything
 * of it crosses, that leases are renewed and recorded, and that a session
 * tree which ends while no worker has it loaded still gets exactly one
 * end-of-session notice.
 *
 * Run: npx vitest run test/local/compute-provider-service.test.js
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createProcessComputeProvider } from "../../src/compute-process.ts";
import { serveComputeProvider } from "../../src/compute-service.ts";
import { ComputeServiceError } from "../../src/compute-service-store.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

/** How this deployment proves PilotSwarm to its provider services. */
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

async function registerService(env, name, baseUrl, identity = {}) {
    return withCatalog(env, (catalog) => catalog.computeServices.create({
        name, baseUrl,
        serverName: identity.serverName ?? `${name}.example.invalid`,
        certificateSha256: identity.certificateSha256 ?? null,
    }, null, true));
}

async function registerTarget(env, label, kind) {
    return withCatalog(env, (catalog) => catalog.computeTargets.create(
        { name: `shared/${label}`, kind, class: "shared", displayName: label }, null, true));
}

async function waitForSessionError(env, sessionId, pattern) {
    return withCatalog(env, async (catalog) => {
        for (let i = 0; i < 60; i++) {
            const events = await catalog.getSessionEvents(sessionId, 0, 200);
            const hit = events.find((event) => pattern.test(JSON.stringify(event.data ?? {})));
            if (hit) return hit;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        return null;
    });
}

/** A self-signed certificate, for the service identity a worker pins. */
function selfSignedCertificate(commonName) {
    const dir = mkdtempSync(join(tmpdir(), "pilotswarm-compute-service-"));
    try {
        execFileSync("openssl", [
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", `/CN=${commonName}`,
            "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
        ], { stdio: "ignore" });
        const cert = readFileSync(join(dir, "cert.pem"), "utf8");
        const key = readFileSync(join(dir, "key.pem"), "utf8");
        const der = Buffer.from(cert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
        return { cert, key, sha256: createHash("sha256").update(der).digest("hex") };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("a compute provider served as a registered provider service", () => {
    it("runs a whole turn through the service, the bridge and the handshake", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const inner = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-service") });
        const service = await serveComputeProvider(inner, { auth: recognizesPilotSwarm });
        try {
            await registerService(env, "served-provider", service.baseUrl);
            await registerTarget(env, "served", "process");
            const marker = `served-${env.runId}`;
            let probeOutput = "";

            const respond = (body, position) => {
                if (position.turn === 1) {
                    if (position.step === 0) {
                        return { tools: [{ name: "bash", args: { command: 'echo "home=$COPILOT_HOME db=${PS_TEST_DATABASE_URL:-none}"', description: "probe" } }] };
                    }
                    probeOutput = position.toolResults.join("\n");
                    return { content: `turn1:${marker}` };
                }
                const sawHistory = JSON.stringify(body.messages).includes(`turn1:${marker}`);
                return { content: `turn2:${sawHistory ? "history" : "no-history"}` };
            };

            await withScriptedModel(env, {
                respond,
                // The worker is given no provider for this kind. Everything
                // it can do with the target, it learned from the register.
                worker: { computeServiceCredentials, computeServiceRefreshMs: 2_000, computeLeaseMs: 5_000, computeLeaseRenewMs: 1_000 },
            }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({ model: qualifiedModel, computeTarget: "shared/served" });
                expect(await session.sendAndWait("first prompt", TIMEOUT)).toBe(`turn1:${marker}`);

                // The worker really went through the service for every step.
                expect(service.calls.describe, "it asked the service what it serves").toBeGreaterThanOrEqual(1);
                expect(service.calls.bind, "it asked the service for a host").toBeGreaterThanOrEqual(1);
                expect(service.calls.connect, "it asked the service how to reach it").toBeGreaterThanOrEqual(1);

                // The turn ran in the service's runtime, not the worker's.
                const hosts = inner.hosts();
                expect(hosts).toHaveLength(1);
                expect(probeOutput).toContain(`home=${hosts[0].homeDir}`);
                expect(probeOutput).toContain("db=none");

                // Credentials stayed with the worker, as on any remote target.
                for (const request of model.sessionRequests("first prompt")) {
                    expect(request.headers.authorization).toBe("Bearer " + "synthetic");
                    expect(JSON.stringify(request.headers)).not.toContain("pilotswarm-worker-secret");
                }

                // The binding was recorded and its lease is being renewed.
                const first = await withCatalog(env, (catalog) => catalog.computeBindings.forRootSession(session.sessionId));
                expect(first, "the binding is recorded").toHaveLength(1);
                expect(first[0].kind).toBe("process");
                expect(first[0].doneAt).toBeNull();
                expect(new Date(first[0].leasedUntil).getTime()).toBeGreaterThan(Date.now() - 1_000);
                expect(JSON.stringify(first[0]), "a binding never holds a secret").not.toMatch(/secret/i);

                const firstLease = new Date(first[0].leasedUntil).getTime();
                let renewed = firstLease;
                for (let i = 0; i < 30 && renewed <= firstLease; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 1_000));
                    const rows = await withCatalog(env, (catalog) => catalog.computeBindings.forRootSession(session.sessionId));
                    renewed = new Date(rows[0].leasedUntil).getTime();
                }
                expect(renewed, "the worker renews the lease while it uses the host").toBeGreaterThan(firstLease);
                expect(service.calls.renew, "the service is told PilotSwarm is still using the host").toBeGreaterThanOrEqual(1);

                // A second turn on the same binding goes the same way.
                expect(await session.sendAndWait("second prompt", TIMEOUT)).toBe("turn2:history");
            });
        } finally {
            await service.close();
            await inner.stopAll();
        }
    });

    it("refuses a service whose identity is not the one registered", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const identity = selfSignedCertificate("served-provider.example.invalid");
        const other = selfSignedCertificate("another-service.example.invalid");
        const inner = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-identity") });
        const service = await serveComputeProvider(inner, {
            auth: recognizesPilotSwarm,
            tls: { cert: identity.cert, key: identity.key },
        });
        try {
            // Registered against a certificate this service does not have:
            // the identity the administrator pinned is not the one that
            // answers. The register also remembers what it last said it
            // served, which is what lets the turn name the real reason.
            const registered = await registerService(env, "wrong-identity", service.baseUrl, {
                serverName: "served-provider.example.invalid",
                certificateSha256: other.sha256,
            });
            await withCatalog(env, (catalog) => catalog.computeServices.recordDescription(registered.id, {
                protocolVersion: 1, kinds: ["process"], transport: "direct",
                capabilities: { os: ["linux"], sandboxed: false, files: "none" },
            }));
            await registerTarget(env, "wrong-identity", "process");

            await withScriptedModel(env, {
                respond: () => ({ content: "should not run" }),
                worker: { computeServiceCredentials },
            }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({ model: qualifiedModel, computeTarget: "shared/wrong-identity" });
                await session.send("hello");
                const hit = await waitForSessionError(env, session.sessionId, /COMPUTE_SERVICE_IDENTITY/);
                expect(hit, "the turn says the service is not the one registered").toBeTruthy();
                expect(JSON.stringify(hit.data)).toMatch(/has not registered for it/);
                expect(model.sessionRequests()).toHaveLength(0);
                expect(inner.hosts(), "no host was ever asked for").toHaveLength(0);
            });
        } finally {
            await service.close();
            await inner.stopAll();
        }
    });

    it("fails the turn when the host cannot prove it holds the binding's secret", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const inner = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-badsecret") });
        // A service that hands the worker a secret the host does not have.
        const liar = {
            ...inner,
            kind: "process",
            async connect(req) {
                const connected = await inner.connect(req);
                if (!connected.ok) return connected;
                return {
                    ...connected,
                    endpoint: {
                        ...connected.endpoint,
                        handshake: { bindingId: connected.endpoint.handshake.bindingId, secret: "0".repeat(64) },
                    },
                };
            },
        };
        const service = await serveComputeProvider(liar, { auth: recognizesPilotSwarm });
        try {
            await registerService(env, "bad-secret", service.baseUrl);
            await registerTarget(env, "bad-secret", "process");

            await withScriptedModel(env, {
                respond: () => ({ content: "should not run" }),
                worker: { computeServiceCredentials },
            }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({ model: qualifiedModel, computeTarget: "shared/bad-secret" });
                await session.send("hello");
                const hit = await waitForSessionError(env, session.sessionId, /COMPUTE_HANDSHAKE_FAILED/);
                expect(hit, "the turn says the handshake failed").toBeTruthy();
                expect(model.sessionRequests(), "nothing of the turn crossed").toHaveLength(0);
            });
        } finally {
            await service.close();
            await inner.stopAll();
        }
    });

    it("gives a session tree that ended while nothing held it exactly one end-of-session notice", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const inner = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-done") });
        const notices = [];
        const watched = {
            ...inner,
            kind: "process",
            async done(req) {
                notices.push({ rootSessionId: req.rootSessionId, reason: req.reason });
                return { ok: true };
            },
        };
        const service = await serveComputeProvider(watched, { auth: recognizesPilotSwarm });
        try {
            await registerService(env, "done-provider", service.baseUrl);
            const target = await registerTarget(env, "done", "process");

            // A binding whose session tree is not in the catalog at all:
            // a tree that ended and was cleaned up while no worker held it.
            const orphan = `tree-that-ended-${env.runId}`;
            await withCatalog(env, (catalog) => catalog.computeBindings.record({
                rootSessionId: orphan,
                targetId: target.id,
                kind: "process",
                host: { kind: "process", id: "host-gone", incarnation: "inc-gone" },
                workerNodeId: "a-worker-that-went-away",
                leaseMs: 1_000,
            }));

            await withScriptedModel(env, {
                respond: () => ({ content: "nothing to say" }),
                worker: { computeServiceCredentials, computeDoneSweepMs: 1_000 },
            }, async () => {
                for (let i = 0; i < 60 && notices.length === 0; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 1_000));
                }
            });

            expect(notices, "the provider is told once").toHaveLength(1);
            expect(notices[0]).toEqual({ rootSessionId: orphan, reason: "deleted" });
            expect(service.calls.done).toBe(1);
            const rows = await withCatalog(env, (catalog) => catalog.computeBindings.forRootSession(orphan));
            expect(rows[0].doneAt, "the notice is recorded, so it is never given twice").toBeTruthy();

            // And a second sweep finds nothing left to tell anyone about.
            const again = await withCatalog(env, (catalog) =>
                catalog.computeBindings.claimDone("another-worker", 10, 0));
            expect(again.map((row) => row.rootSessionId)).not.toContain(orphan);
        } finally {
            await service.close();
            await inner.stopAll();
        }
    });

    it("lets only an administrator register a provider service, and keeps its rules in SQL", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await withCatalog(env, async (catalog) => {
            const store = catalog.computeServices;
            const url = "https://a-service.example.invalid/compute";

            const user = await catalog.computeTargets.lookupUserId({ provider: "test-idp", subject: "someone" });
            const denied = await store.create({ name: "not-mine", baseUrl: url, serverName: "a-service.example.invalid" }, user, false)
                .catch((error) => error);
            expect(denied).toBeInstanceOf(ComputeServiceError);
            expect(denied.code).toBe("COMPUTE_SERVICE_FORBIDDEN");
            const listDenied = await store.list(false).catch((error) => error);
            expect(listDenied.code, "the register is an administrator's business alone").toBe("COMPUTE_SERVICE_FORBIDDEN");

            // An identity is what makes the registration a trust anchor.
            const noIdentity = await store.create({ name: "faceless", baseUrl: url }, null, true).catch((error) => error);
            expect(noIdentity.code).toBe("COMPUTE_SERVICE_INVALID");

            // https everywhere, except a service on this machine.
            const plain = await store.create({ name: "plain", baseUrl: "http://a-service.example.invalid", serverName: "x" }, null, true)
                .catch((error) => error);
            expect(plain.code).toBe("COMPUTE_SERVICE_INVALID");
            const loopback = await store.create({ name: "on-this-machine", baseUrl: "http://127.0.0.1:8080", serverName: "x" }, null, true);
            expect(loopback.enabled).toBe(true);

            const created = await store.create({
                name: "a-service", baseUrl: url,
                serverName: "a-service.example.invalid",
                certificateSha256: "ab".repeat(32),
            }, null, true);
            expect(created.identity.certificateSha256).toBe("ab".repeat(32));
            expect(created.kinds, "nothing is registered by hand but where it is and who it is").toEqual([]);
            expect(JSON.stringify(created), "a registration never holds a secret").not.toMatch(/secret|token|password/i);

            const duplicate = await store.create({ name: "a-service", baseUrl: url, serverName: "x" }, null, true).catch((error) => error);
            expect(duplicate.code).toBe("COMPUTE_SERVICE_CONFLICT");

            // What it serves is what it said, recorded with the time.
            const described = await store.recordDescription(created.id, {
                protocolVersion: 1, kinds: ["a-kind"], transport: "pipe",
                capabilities: { os: ["linux"], sandboxed: true, files: "none" },
            });
            expect(described.kinds).toEqual(["a-kind"]);
            expect(described.transport).toBe("pipe");
            expect(described.describedAt).toBeTruthy();
            expect((await store.enabled()).map((s) => s.name).sort()).toEqual(["a-service", "on-this-machine"]);

            // Moving a service makes it say again what it serves.
            const moved = await store.update("a-service", { baseUrl: "https://moved.example.invalid" }, null, true);
            expect(moved.describedAt).toBeNull();
            expect(moved.capabilities).toBeNull();
            // What it last served is kept: it decides nothing, and it is
            // what lets a turn say why a target cannot run.
            expect(moved.kinds).toEqual(["a-kind"]);

            // A service still serving targets cannot be removed.
            await catalog.computeTargets.create({ name: "shared/on-a-kind", kind: "a-kind", class: "shared" }, null, true);
            const inUse = await store.delete("a-service", null, true).catch((error) => error);
            expect(inUse.code).toBe("COMPUTE_SERVICE_IN_USE");
            await catalog.computeTargets.delete("shared/on-a-kind", null, true);
            expect(await store.delete("a-service", null, true)).toBe(true);

            const gone = await store.delete("a-service", null, true).catch((error) => error);
            expect(gone.code).toBe("COMPUTE_SERVICE_NOT_FOUND");
        });
    });
});

describe("checking a compute target", () => {
    it("takes the same bridged, handshaken path a turn does", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const inner = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-probe") });
        const service = await serveComputeProvider(inner, { auth: recognizesPilotSwarm });
        try {
            await registerService(env, "probe-provider", service.baseUrl);
            const target = await registerTarget(env, "probe", "process");

            await withScriptedModel(env, {
                respond: () => ({ content: "nothing to say" }),
                worker: { computeServiceCredentials },
            }, async ({ worker }) => {
                // What the management probe runs on a worker.
                const checked = await worker.sessionManager.probeComputeTargetById(target.id, null);
                expect(checked.ok, JSON.stringify(checked)).toBe(true);
                expect(checked.target.advertised, "a check records what the target offers").toBeTruthy();
                expect(checked.target.advertised.os).toBeTruthy();

                // It really went through the service, and through a host
                // component that answered the handshake: the runtime was
                // reached, and no connection was refused on the way.
                expect(service.calls.bind).toBeGreaterThanOrEqual(1);
                expect(service.calls.connect).toBeGreaterThanOrEqual(1);
                expect(service.calls.release).toBeGreaterThanOrEqual(1);
                expect(inner.hosts(), "the probe leaves no host behind").toHaveLength(0);
            });
        } finally {
            await service.close();
            await inner.stopAll();
        }
    });

    it("refuses to check a target whose host cannot prove itself", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const inner = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-probe-bad") });
        const liar = {
            ...inner,
            kind: "process",
            async connect(req) {
                const connected = await inner.connect(req);
                if (!connected.ok) return connected;
                return {
                    ...connected,
                    endpoint: { ...connected.endpoint, handshake: { bindingId: connected.endpoint.handshake.bindingId, secret: "0".repeat(64) } },
                };
            },
        };
        const service = await serveComputeProvider(liar, { auth: recognizesPilotSwarm });
        try {
            await registerService(env, "probe-bad-provider", service.baseUrl);
            const target = await registerTarget(env, "probe-bad", "process");

            await withScriptedModel(env, {
                respond: () => ({ content: "nothing to say" }),
                worker: { computeServiceCredentials },
            }, async ({ worker }) => {
                const checked = await worker.sessionManager.probeComputeTargetById(target.id, null);
                expect(checked.ok).toBe(false);
                expect(checked.code).toBe("COMPUTE_HANDSHAKE_FAILED");
            });
        } finally {
            await service.close();
            await inner.stopAll();
        }
    });
});
