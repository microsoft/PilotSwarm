/**
 * Registered provider services (docs/proposals/compute-providers.md,
 * "Provider services and registration").
 *
 * A provider that runs outside the worker is reached through one generic
 * adapter. What these hold it to: every call and every refusal crosses
 * faithfully in both directions; a service that does not recognize the
 * caller is refused; a service the registration's identity does not match
 * is refused; what a service says about itself is what the worker serves;
 * and a service that cannot be reached leaves its kinds failing with a
 * reason rather than silently missing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    buildComputeServiceProviders,
    checkComputeServiceCertificate,
    checkComputeServiceUrl,
    ComputeServiceClient,
    createRemoteComputeProvider,
    serveComputeProvider,
    COMPUTE_SERVICE_PROTOCOL_VERSION,
} from "../../dist/compute-service.js";
import { ComputeProviderRegistry, COMPUTE_ERROR_CODES } from "../../dist/compute.js";

const CREDENTIAL = "a-shared-test-credential";
const credentials = async () => ({ headers: { "x-pilotswarm-credential": CREDENTIAL } });
const auth = (headers) => headers["x-pilotswarm-credential"] === CREDENTIAL;

const target = {
    id: "11111111-2222-3333-4444-555555555555",
    name: "shared/pool", kind: "served-kind", class: "shared",
    ownerUserId: null, displayName: null, config: { size: "m" }, enabled: true,
};

/** A provider with no platform behind it: it records what it was asked. */
function recordingProvider(overrides = {}) {
    const seen = [];
    return {
        kind: "served-kind",
        capabilities: { os: ["linux"], sandboxed: true, files: "none" },
        seen,
        async validateTarget(req) { seen.push(["validate", req.target.config]); return { ok: true }; },
        async bind(req) {
            seen.push(["bind", req.rootSessionId]);
            return { ok: true, host: { kind: "served-kind", id: "host-1", incarnation: "inc-1", data: { private: true } } };
        },
        async connect(req) {
            seen.push(["connect", req.turnIndex]);
            return {
                ok: true,
                endpoint: {
                    transport: "uri", address: "127.0.0.1:9", connectionToken: "runtime-token",
                    handshake: { bindingId: "binding-x", secret: "s".repeat(64) },
                },
                workspace: { cwd: "/host/work" },
            };
        },
        async describeHost() { return { os: "linux", details: { note: "a host" } }; },
        async release(req) { seen.push(["release", req.reason]); },
        async renew(req) { seen.push(["renew", req.leaseMs]); return { ok: true }; },
        async done(req) { seen.push(["done", req.reason]); return { ok: true }; },
        ...overrides,
    };
}

async function servedProvider(t, provider, options = {}) {
    const service = await serveComputeProvider(provider, { auth, ...options });
    t.after(() => service.close());
    const registration = {
        id: "99999999-8888-7777-6666-555555555555",
        name: "test-service",
        baseUrl: service.baseUrl,
        identity: { serverName: "test-service.example.invalid", certificateSha256: null },
        enabled: true, kinds: ["served-kind"], transport: provider.transport ?? "direct",
        capabilities: provider.capabilities, protocolVersion: COMPUTE_SERVICE_PROTOCOL_VERSION,
        describedAt: null, registeredBy: null,
    };
    return { service, registration };
}

const call = { signal: AbortSignal.timeout(10_000) };

test("every call and its answer cross between the worker and a provider service", async (t) => {
    const provider = recordingProvider();
    const { service, registration } = await servedProvider(t, provider);
    const client = new ComputeServiceClient(registration, credentials);

    const described = await client.describe();
    assert.deepEqual(described.kinds, ["served-kind"]);
    assert.equal(described.transport, "direct");
    assert.equal(described.protocolVersion, COMPUTE_SERVICE_PROTOCOL_VERSION);

    const adapter = createRemoteComputeProvider(registration, "served-kind", client);
    assert.deepEqual(await adapter.validateTarget({ target, principal: null, ...call }), { ok: true });

    const bound = await adapter.bind({ target, sessionId: "s1", rootSessionId: "root-1", owner: null, workerNodeId: "node-a", ...call });
    assert.equal(bound.ok, true);
    assert.deepEqual(bound.host, { kind: "served-kind", id: "host-1", incarnation: "inc-1", data: { private: true } });

    const connected = await adapter.connect({
        target, host: bound.host, sessionId: "s1", rootSessionId: "root-1",
        workerNodeId: "node-a", turnIndex: 3, workspace: {}, ...call,
    });
    assert.equal(connected.ok, true);
    assert.equal(connected.endpoint.transport, "uri");
    assert.equal(connected.endpoint.address, "127.0.0.1:9");
    assert.equal(connected.endpoint.connectionToken, "runtime-token");
    assert.equal(connected.endpoint.handshake.bindingId, "binding-x");
    assert.deepEqual(connected.workspace, { cwd: "/host/work" });

    assert.deepEqual(await adapter.describeHost({ target, host: bound.host, ...call }), { os: "linux", details: { note: "a host" } });
    assert.deepEqual(await adapter.renew({ target, host: bound.host, rootSessionId: "root-1", workerNodeId: "node-a", leaseMs: 180_000, ...call }), { ok: true });
    assert.deepEqual(await adapter.done({ target, host: bound.host, rootSessionId: "root-1", workerNodeId: "node-a", reason: "ended", ...call }), { ok: true });
    await adapter.release({ target, host: bound.host, sessionId: "s1", rootSessionId: "root-1", workerNodeId: "node-a", reason: "ended", ...call });

    // The provider saw the worker's own calls, with the target's config.
    assert.deepEqual(provider.seen, [
        ["validate", { size: "m" }],
        ["bind", "root-1"],
        ["connect", 3],
        ["renew", 180_000],
        ["done", "ended"],
        ["release", "ended"],
    ]);
    assert.equal(service.calls.bind, 1);
});

test("a refusal from the provider keeps its code and its reason", async (t) => {
    const provider = recordingProvider({
        async bind() {
            return { ok: false, code: COMPUTE_ERROR_CODES.UNAVAILABLE, message: "no host is free", retryAfterMs: 7_000 };
        },
    });
    const { registration } = await servedProvider(t, provider);
    const adapter = createRemoteComputeProvider(registration, "served-kind", new ComputeServiceClient(registration, credentials));
    const bound = await adapter.bind({ target, sessionId: "s", rootSessionId: "r", owner: null, workerNodeId: "n", ...call });
    assert.deepEqual(bound, { ok: false, code: COMPUTE_ERROR_CODES.UNAVAILABLE, message: "no host is free", retryAfterMs: 7_000 });
});

test("a service that does not recognize the caller refuses the call", async (t) => {
    const { registration } = await servedProvider(t, recordingProvider());
    const wrong = new ComputeServiceClient(registration, async () => ({ headers: { "x-pilotswarm-credential": "not-it" } }));
    await assert.rejects(wrong.describe(), (error) => /refused describe \(401\)/.test(error.message));
});

test("a certificate the registration does not pin is refused", () => {
    const pinned = "ab".repeat(32);
    const identity = { serverName: null, certificateSha256: pinned };
    assert.deepEqual(checkComputeServiceCertificate(identity, { fingerprint256: "AB:".repeat(31) + "AB" }), { ok: true });
    const wrong = checkComputeServiceCertificate(identity, { fingerprint256: "cd".repeat(32) }, "a-service");
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, COMPUTE_ERROR_CODES.SERVICE_IDENTITY);
    const none = checkComputeServiceCertificate(identity, {}, "a-service");
    assert.equal(none.code, COMPUTE_ERROR_CODES.SERVICE_IDENTITY);
    // With nothing pinned, ordinary TLS validation is the identity.
    assert.deepEqual(checkComputeServiceCertificate({ serverName: "x" }, {}), { ok: true });
});

test("a service is reached over https, and plainly only on this machine", () => {
    assert.equal(checkComputeServiceUrl("https://service.example.invalid/compute").ok, true);
    assert.equal(checkComputeServiceUrl("http://127.0.0.1:8080").ok, true);
    assert.equal(checkComputeServiceUrl("http://service.example.invalid").ok, false);
    assert.equal(checkComputeServiceUrl("ftp://service.example.invalid").ok, false);
    assert.equal(checkComputeServiceUrl("not a url").ok, false);
});

test("what a service says about itself is what the worker serves", async (t) => {
    const { service, registration } = await servedProvider(t, recordingProvider());
    const recorded = [];
    const providers = await buildComputeServiceProviders([{ ...registration, kinds: [] }], {
        credentials,
        recordDescription: async (id, described) => { recorded.push([id, described.kinds, described.transport]); },
    });
    assert.deepEqual(providers.map((p) => p.kind), ["served-kind"]);
    assert.deepEqual(recorded, [[registration.id, ["served-kind"], "direct"]]);
    assert.equal(service.calls.describe, 1);

    // The registry serves it, and a built-in provider of the same kind wins.
    const registry = new ComputeProviderRegistry();
    registry.setServiceProviders(providers);
    assert.deepEqual(registry.serviceKinds(), ["served-kind"]);
    assert.equal(registry.get("served-kind").capabilities.os[0], "linux");

    // An administrator who removes the service stops it being served.
    registry.setServiceProviders([]);
    assert.equal(registry.get("served-kind"), undefined);
    assert.deepEqual(registry.serviceKinds(), []);
});

test("a service that cannot be reached leaves its kinds refusing with a reason", async () => {
    const registration = {
        id: "99999999-8888-7777-6666-555555555555",
        name: "gone-service",
        // Nothing listens here: a service that has gone away.
        baseUrl: "http://127.0.0.1:1",
        identity: { serverName: "gone-service.example.invalid", certificateSha256: null },
        enabled: true, kinds: ["served-kind"], transport: "direct",
        capabilities: null, protocolVersion: null, describedAt: null, registeredBy: null,
    };
    const providers = await buildComputeServiceProviders([registration], { credentials });
    assert.equal(providers.length, 1);
    const refused = await providers[0].bind({ target, sessionId: "s", rootSessionId: "r", owner: null, workerNodeId: "n", ...call });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, COMPUTE_ERROR_CODES.SERVICE_UNAVAILABLE);
    assert.match(refused.message, /"gone-service" is not usable/);
});

test("a service that opens its own connections hands back a connection, not an address", async (t) => {
    // The inner provider's pipe is a plain in-memory stream: what matters
    // is that the worker never learns anything about it but a URL.
    const { Duplex } = await import("node:stream");
    const provider = recordingProvider({
        transport: "pipe",
        async connect() {
            return { ok: true, endpoint: { transport: "pipe", details: { mark: "private" }, handshake: { bindingId: "b", secret: "s".repeat(64) } }, workspace: {} };
        },
        async openConnection(req) {
            const echoed = `opened:${req.details.mark}`;
            return new Duplex({
                read() { this.push(echoed); this.push(null); },
                write(_chunk, _enc, done) { done(); },
            });
        },
    });
    const { registration } = await servedProvider(t, provider);
    const client = new ComputeServiceClient(registration, credentials);
    const adapter = createRemoteComputeProvider({ ...registration, transport: "pipe" }, "served-kind", client);
    assert.equal(adapter.transport, "pipe");

    const connected = await adapter.connect({
        target, host: { kind: "served-kind", id: "h", incarnation: "i" },
        sessionId: "s", rootSessionId: "r", workerNodeId: "n", turnIndex: 0, workspace: {}, ...call,
    });
    assert.equal(connected.ok, true);
    assert.equal(connected.endpoint.transport, "pipe");
    assert.match(String(connected.endpoint.details.url), /^ws:\/\/127\.0\.0\.1:\d+\/v1\/pipe\?c=/);
    assert.equal(connected.endpoint.details.mark, undefined, "the service's own details never reach the worker");

    const pipe = await adapter.openConnection({
        target, host: { kind: "served-kind", id: "h", incarnation: "i" },
        details: connected.endpoint.details, ...call,
    });
    const got = await new Promise((resolve) => pipe.once("data", (chunk) => resolve(chunk.toString())));
    assert.equal(got, "opened:private");
    pipe.destroy();
});
