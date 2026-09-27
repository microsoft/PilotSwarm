// Checks every relay provider must pass. A provider's test file calls
// relayContract() with its own transports; the checks never know which relay
// service is underneath. Providers import this as
// "pilotswarm-relay-core/testing/contract".

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
    ClusterSigner,
    HostSigner,
    MemoryHostRegistry,
    OwnerAllowList,
    RelayAccessError,
    RelayExecClient,
    RelayTransportError,
    TrustedClusters,
    decodeMessage,
    describeThisHost,
    encodeMessage,
    generateKeyPair,
    hashSecret,
    newChallenge,
    serveConnection,
} from "../dist/index.js";

// The contract host serves Alice (listed by email, different case) and Bob (listed by object id).
const BOB_OID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ALLOWED = OwnerAllowList.parse(["Alice@Example.com", BOB_OID]);
const ALICE = { id: "session-alice", owner: { provider: "entra", subject: "11111111-1111-4111-8111-111111111111", email: "alice@example.com" } };
const BOB = { id: "session-bob", owner: { provider: "entra", subject: BOB_OID.toUpperCase(), email: "bob@elsewhere.example" } };
const MALLORY = { id: "session-mallory", owner: { provider: "entra", subject: "22222222-2222-4222-8222-222222222222", email: "mallory@example.com" } };
const DEV_ALICE = { id: "session-dev", owner: { provider: "dev", subject: "alice", email: "alice@example.com" } };

// The cluster the host trusts, and one it does not.
const OUR_KEY = generateKeyPair();
const OUR_CLUSTER = new ClusterSigner(OUR_KEY.privateKeyPem);
const OUR_CLUSTER_PUBLIC_PEM = OUR_KEY.publicKeyPem;
const OTHER_CLUSTER = new ClusterSigner(generateKeyPair().privateKeyPem);

// The host key the cluster pinned for the contract endpoint, and fresh keys for other tests.
const newHostKey = () => new HostSigner(generateKeyPair().privateKeyPem);
const PINNED_HOST = newHostKey();

const MINUTE = 60_000;
function hostRecord(endpointId, fields) {
    return {
        hostId: `h-${randomBytes(4).toString("hex")}`,
        endpointId,
        provider: "contract",
        issuedTo: ALICE.owner,
        createdAt: new Date().toISOString(),
        ...fields,
    };
}
function pendingRegistry(endpointId, secret, expiresInMs = 10 * MINUTE) {
    const registry = new MemoryHostRegistry();
    registry.add(hostRecord(endpointId, {
        status: "pending",
        activation: { secretSha256: hashSecret(secret), expiresAt: new Date(Date.now() + expiresInMs).toISOString() },
    }));
    return registry;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitFor(check, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await sleep(50);
    }
    assert.fail(`timed out waiting for ${what}`);
}

/** RELAY_CONTRACT_DEBUG=1: log every message type the caller sends and receives. Test-only. */
function debugTransport(transport) {
    if (!process.env.RELAY_CONTRACT_DEBUG) return transport;
    const stamp = () => new Date().toISOString().slice(11, 23);
    const kind = (frame) => {
        try {
            const m = decodeMessage(frame);
            return m.type + (m.id ? ` ${String(m.id).slice(0, 8)}` : "");
        } catch {
            return `raw ${frame.length} B`;
        }
    };
    return {
        provider: transport.provider,
        endpointId: transport.endpointId,
        listen: () => transport.listen(),
        async connect() {
            const connection = await transport.connect();
            const tag = `caller[${connection.id.slice(0, 6)}]`;
            console.log(`# ${stamp()} ${tag} connected`);
            connection.onFrame((frame) => console.log(`# ${stamp()} ${tag} <- ${kind(frame)}`));
            connection.onClose((info) => console.log(`# ${stamp()} ${tag} closed ${info.code} ${info.reason}`));
            return {
                get id() { return connection.id; },
                get isOpen() { return connection.isOpen; },
                send: (frame) => {
                    console.log(`# ${stamp()} ${tag} -> ${kind(frame)}`);
                    return connection.send(frame);
                },
                onFrame: (h) => connection.onFrame(h),
                onClose: (h) => connection.onClose(h),
                close: (reason) => connection.close(reason),
            };
        },
    };
}

/**
 * @param {string} name
 * @param {{ hostTransport: () => import("../dist/index.js").RelayTransport,
 *           callerTransport: () => import("../dist/index.js").RelayTransport }} adapter
 */
export function relayContract(name, adapter) {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "relay-contract-"));
    const hostTransport = adapter.hostTransport();
    let listener;
    let client;
    /** client.exec as Alice, who is on the allow list. */
    let exec;
    const hostConnections = [];
    /** Every line the host logs. Used to prove a request never reached it. */
    const hostLog = [];
    // When set, the next arriving connection goes to the raw-frame check instead of serveConnection().
    let takeRaw;
    // When set, the next served connection uses this host key and activation secret (used once).
    let nextHost;
    /** Credentials the cluster pushed, and activations it confirmed, as the host saw them. */
    const grantUpdates = [];
    let activationsSeen = 0;
    let grantCounter = 0;
    // The cluster's view: the contract endpoint's host is active with PINNED_HOST's key.
    const registry = new MemoryHostRegistry();
    registry.add(hostRecord(hostTransport.endpointId, {
        status: "active",
        activation: { secretSha256: hashSecret("spent"), expiresAt: new Date().toISOString(), usedAt: new Date().toISOString() },
        hostKey: { fingerprint: PINNED_HOST.fingerprint, publicKeyPem: PINNED_HOST.publicKeyPem },
    }));
    const clusterClient = (hostRegistry = registry, signer = OUR_CLUSTER) =>
        new RelayExecClient(debugTransport(adapter.callerTransport()), signer, { hostRegistry, grantUpdate: () => ({ grant: ++grantCounter }) });

    after(() => {
        client?.close();
        listener?.close();
        rmSync(scratch, { recursive: true, force: true });
    });

    /**
     * A caller that speaks the protocol by hand, to test what the host does
     * when the caller skips a step or cheats.
     */
    async function rawCaller() {
        const transport = adapter.callerTransport();
        const connection = await transport.connect();
        const inbox = [];
        let closed = false;
        connection.onFrame((frame) => inbox.push(decodeMessage(frame)));
        connection.onClose(() => (closed = true));
        const next = async (type) => {
            await waitFor(() => inbox.some((m) => m.type === type) || closed, 15_000, `a '${type}' message`);
            const found = inbox.find((m) => m.type === type);
            if (!found) assert.fail(`connection closed before a '${type}' message`);
            return found;
        };
        const hello = await next("hello");
        const auth = (signer, endpointId = transport.endpointId, challenge = hello.challenge) =>
            connection.send(
                encodeMessage({ type: "auth", cluster: signer.fingerprint, signature: signer.signChallenge(endpointId, challenge), challenge: newChallenge() }),
            );
        return { connection, transport, hello, next, auth, isClosed: () => closed, inbox };
    }

    test(`${name}: connecting with no host listening fails with no_listener`, { timeout: 60_000 }, async () => {
        await assert.rejects(adapter.callerTransport().connect(), (error) => {
            assert.ok(error instanceof RelayTransportError, `expected RelayTransportError, got ${error}`);
            assert.equal(error.kind, "no_listener");
            return true;
        });
    });

    test(`${name}: host registers; our cluster passes the handshake and gets ready`, { timeout: 60_000 }, async () => {
        assert.equal(hostTransport.endpointId, adapter.callerTransport().endpointId, "both sides must name the same endpoint");
        listener = await hostTransport.listen();
        listener.onConnection((connection) => {
            if (takeRaw) {
                const take = takeRaw;
                takeRaw = undefined;
                take(connection);
                return;
            }
            hostConnections.push(connection);
            const as = nextHost ?? { signer: PINNED_HOST };
            nextHost = undefined;
            serveConnection(connection, {
                host: describeThisHost(),
                trustedClusters: TrustedClusters.fromPublicKeyPems([OUR_CLUSTER_PUBLIC_PEM]),
                hostSigner: as.signer,
                activationSecret: () => as.activationSecret,
                onActivated: () => activationsSeen++,
                onGrantUpdate: (grant) => grantUpdates.push(grant),
                endpointId: hostTransport.endpointId,
                allowedOwners: ALLOWED,
                authTimeoutMs: 2000,
                log: (line) => {
                    hostLog.push(line);
                    // RELAY_CONTRACT_DEBUG=1 prints the host's log live, to chase intermittent failures.
                    if (process.env.RELAY_CONTRACT_DEBUG) console.log(`# ${new Date().toISOString().slice(11, 23)} host[${connection.id.slice(0, 6)}] ${line}`);
                },
            });
            if (process.env.RELAY_CONTRACT_DEBUG) {
                console.log(`# ${new Date().toISOString().slice(11, 23)} host[${connection.id.slice(0, 6)}] connection opened`);
                connection.onClose((info) => console.log(`# ${new Date().toISOString().slice(11, 23)} host[${connection.id.slice(0, 6)}] closed ${info.code} ${info.reason}`));
            }
        });
        client = clusterClient();
        exec = (call) => client.exec({ session: ALICE, ...call });
        const host = await client.host();
        assert.equal(host.relayPid, process.pid);
    });

    // ---- the cluster lock ----------------------------------------------------

    test(`${name}: hello reveals nothing but a fresh challenge`, { timeout: 60_000 }, async () => {
        const a = await rawCaller();
        const b = await rawCaller();
        assert.deepEqual(Object.keys(a.hello).sort(), ["challenge", "protocolVersion", "type"]);
        assert.notEqual(a.hello.challenge, b.hello.challenge);
        a.connection.close();
        b.connection.close();
    });

    test(`${name}: another cluster's key is refused`, { timeout: 60_000 }, async () => {
        const stranger = clusterClient(registry, OTHER_CLUSTER);
        await assert.rejects(stranger.host(), (error) => {
            assert.ok(error instanceof RelayTransportError, `expected RelayTransportError, got ${error}`);
            assert.equal(error.kind, "unauthorized");
            assert.match(error.message, /not a trusted cluster/);
            return true;
        });
    });

    test(`${name}: our key, signed for a different endpoint, is refused`, { timeout: 60_000 }, async () => {
        const raw = await rawCaller();
        await raw.auth(OUR_CLUSTER, "some-other-namespace/some-other-endpoint");
        const failed = await raw.next("auth_failed");
        assert.match(failed.reason, /not a trusted cluster/);
        await waitFor(raw.isClosed, 10_000, "the host to close the connection");
    });

    test(`${name}: a signature replayed from another connection is refused`, { timeout: 60_000 }, async () => {
        const first = await rawCaller();
        const second = await rawCaller();
        // Sign the FIRST connection's challenge, send it on the SECOND.
        await second.auth(OUR_CLUSTER, second.transport.endpointId, first.hello.challenge);
        await second.next("auth_failed");
        await waitFor(second.isClosed, 10_000, "the host to close the connection");
        first.connection.close();
    });

    test(`${name}: a command sent before the handshake is refused and nothing runs`, { timeout: 60_000 }, async () => {
        const marker = path.join(scratch, `ran-${randomBytes(4).toString("hex")}`);
        const raw = await rawCaller();
        await raw.connection.send(encodeMessage({ type: "exec", id: "early", session: ALICE, command: ["touch", marker], timeoutSeconds: 5 }));
        await raw.next("auth_failed");
        await waitFor(raw.isClosed, 10_000, "the host to close the connection");
        assert.equal(existsSync(marker), false, "the command ran");
    });

    test(`${name}: a caller that never authenticates is closed`, { timeout: 60_000 }, async () => {
        const raw = await rawCaller();
        const failed = await raw.next("auth_failed");
        assert.match(failed.reason, /in time/);
        await waitFor(raw.isClosed, 10_000, "the host to close the connection");
    });

    test(`${name}: a credential update sent before the handshake is refused`, { timeout: 60_000 }, async () => {
        const before = grantUpdates.length;
        const raw = await rawCaller();
        await raw.connection.send(encodeMessage({ type: "grant_update", grant: { evil: true } }));
        await raw.next("auth_failed");
        await waitFor(raw.isClosed, 10_000, "the host to close the connection");
        assert.equal(grantUpdates.length, before, "the host accepted a credential from an unauthenticated caller");
    });

    test(`${name}: the activation secret is revealed only to a trusted cluster`, { timeout: 60_000 }, async () => {
        const secret = `do-not-leak-${randomBytes(8).toString("hex")}`;
        nextHost = { signer: newHostKey(), activationSecret: secret };
        const raw = await rawCaller();
        await raw.auth(OTHER_CLUSTER);
        await raw.next("auth_failed");
        await waitFor(raw.isClosed, 10_000, "the host to close the connection");
        assert.equal(JSON.stringify(raw.inbox).includes(secret), false, "the host sent its activation secret to an untrusted caller");
    });

    // ---- the cluster checks the host -----------------------------------------

    test(`${name}: the cluster pushes a fresh credential right after the handshake`, { timeout: 60_000 }, async () => {
        await waitFor(() => grantUpdates.length > 0, 10_000, "a credential update to reach the host");
        assert.equal(typeof grantUpdates.at(-1).grant, "number");
    });

    test(`${name}: an impostor host key on the endpoint is refused and gets no command`, { timeout: 60_000 }, async () => {
        nextHost = { signer: newHostKey() };
        const logBefore = hostLog.length;
        const cluster = clusterClient();
        await assert.rejects(cluster.exec({ session: ALICE, command: ["echo", "secret data"] }), (error) => {
            assert.ok(error instanceof RelayTransportError, `expected RelayTransportError, got ${error}`);
            assert.equal(error.kind, "unauthorized");
            assert.match(error.message, /does not match the key pinned/);
            return true;
        });
        await sleep(300);
        const lines = hostLog.slice(logBefore);
        assert.ok(lines.some((line) => /cluster refused this host/.test(line)), "the impostor was not told it was refused");
        assert.deepEqual(lines.filter((line) => /^exec /.test(line)), [], "a command reached the impostor");
    });

    test(`${name}: first contact activates the host once and pins its key`, { timeout: 60_000 }, async () => {
        const secret = randomBytes(16).toString("hex");
        const hostKey = newHostKey();
        const pending = pendingRegistry(hostTransport.endpointId, secret);
        const seenBefore = activationsSeen;

        nextHost = { signer: hostKey, activationSecret: secret };
        const first = clusterClient(pending);
        await first.host();
        assert.equal(await pending.pinnedHostKey(hostTransport.endpointId), hostKey.publicKeyPem);
        await waitFor(() => activationsSeen === seenBefore + 1, 10_000, "the host to hear it was activated");
        first.close();

        // Later connections need no secret: the key is pinned.
        nextHost = { signer: hostKey };
        const again = clusterClient(pending);
        await again.host();
        again.close();

        // The same secret with a different key does not work a second time.
        nextHost = { signer: newHostKey(), activationSecret: secret };
        await assert.rejects(clusterClient(pending).host(), /does not match the key pinned/);
    });

    for (const [label, secretSent, expiresInMs, reason] of [
        ["a wrong activation secret", "not-the-secret", 10 * MINUTE, /wrong activation secret/],
        ["an expired activation window", "right-secret", -1 * MINUTE, /activation window closed/],
        ["no activation secret and no pinned key", undefined, 10 * MINUTE, /not activated and sent no activation secret/],
    ]) {
        test(`${name}: ${label} is refused and the host stays pending`, { timeout: 60_000 }, async () => {
            const pending = pendingRegistry(hostTransport.endpointId, "right-secret", expiresInMs);
            nextHost = { signer: newHostKey(), activationSecret: secretSent };
            await assert.rejects(clusterClient(pending).host(), reason);
            assert.equal(await pending.pinnedHostKey(hostTransport.endpointId), undefined);
            assert.equal(pending.list()[0].status, "pending");
        });
    }

    test(`${name}: a bad host signature never uses up the activation secret`, { timeout: 60_000 }, async () => {
        const secret = "the-real-secret";
        const pending = pendingRegistry(hostTransport.endpointId, secret);
        const claimed = newHostKey();
        const actual = newHostKey();
        // Presents one key but signs with another.
        nextHost = {
            signer: { fingerprint: claimed.fingerprint, publicKeyPem: claimed.publicKeyPem, signChallenge: (...a) => actual.signChallenge(...a) },
            activationSecret: secret,
        };
        await assert.rejects(clusterClient(pending).host(), /signature does not match the key it sent/);
        assert.equal(pending.list()[0].status, "pending", "the secret was spent on a bad proof");

        nextHost = { signer: actual, activationSecret: secret };
        const ok = clusterClient(pending);
        await ok.host();
        ok.close();
    });

    // ---- the transport -------------------------------------------------------

    test(`${name}: frames go both ways at once, intact and in order, including one over 64 KB`, { timeout: 60_000 }, async () => {
        const hostSide = new Promise((resolve) => (takeRaw = resolve));
        const caller = await adapter.callerTransport().connect();
        const host = await hostSide;

        // 100 small frames each way, sent at the same time, plus a 1 MiB frame each way.
        const small = Array.from({ length: 100 }, (_, i) => Buffer.from(`frame-${i}-${randomBytes(8).toString("hex")}`));
        const big = randomBytes(1024 * 1024);
        const expected = [...small, big].map(sha256);

        const collect = (connection) =>
            new Promise((resolve) => {
                const seen = [];
                connection.onFrame((frame) => {
                    seen.push(sha256(frame));
                    if (seen.length === expected.length) resolve(seen);
                });
            });
        const atHost = collect(host);
        const atCaller = collect(caller);
        await Promise.all([
            (async () => {
                for (const frame of [...small, big]) await caller.send(frame);
            })(),
            (async () => {
                for (const frame of [...small, big]) await host.send(frame);
            })(),
        ]);
        assert.deepEqual(await atHost, expected, "caller → host");
        assert.deepEqual(await atCaller, expected, "host → caller");
        caller.close();
    });

    // ---- running commands ----------------------------------------------------

    test(`${name}: exec returns exit code with stdout and stderr kept apart`, { timeout: 60_000 }, async () => {
        const { result } = await exec({ command: ["sh", "-c", "echo out; echo err >&2; exit 3"] });
        assert.equal(result.status, "exited");
        assert.equal(result.exitCode, 3);
        assert.equal(result.stdout.text, "out\n");
        assert.equal(result.stderr.text, "err\n");
        assert.equal(result.timedOut, false);
    });

    test(`${name}: stdin reaches the command`, { timeout: 60_000 }, async () => {
        const { result } = await exec({ command: ["wc", "-c"], stdin: "hello" });
        assert.equal(result.stdout.text.trim(), "5");
    });

    test(`${name}: large output is counted and hashed in full and cut inline`, { timeout: 60_000 }, async () => {
        const { result } = await exec({ command: ["sh", "-c", "yes a | head -c 300000"] });
        const full = Buffer.from("a\n".repeat(150000));
        assert.equal(result.stdout.bytes, 300000);
        assert.equal(result.stdout.sha256, sha256(full));
        assert.equal(result.stdout.truncated, true);
        assert.equal(result.stdout.text.length, 64 * 1024);
    });

    test(`${name}: a missing executable is a start failure, not a crash`, { timeout: 60_000 }, async () => {
        const { result } = await exec({ command: ["definitely-not-a-real-binary-7f3a"] });
        assert.equal(result.status, "start_failed");
        assert.match(result.error, /ENOENT/);
    });

    test(`${name}: timeout kills the whole process tree`, { timeout: 60_000 }, async () => {
        const pidFile = path.join(scratch, "timeout.pid");
        const started = Date.now();
        const { result } = await exec({
            // The background sleep is a grandchild. Killing only `sh` would leave it running.
            command: ["sh", "-c", `sleep 60 & echo $! > ${pidFile}; wait`],
            timeoutSeconds: 1,
        });
        assert.equal(result.timedOut, true);
        assert.ok(Date.now() - started < 10_000, "timed-out command took too long to return");
        const grandchild = Number(readFileSync(pidFile, "utf8"));
        await waitFor(() => !isAlive(grandchild), 5000, `grandchild ${grandchild} to die`);
    });

    test(`${name}: losing the connection fails the call and kills the command`, { timeout: 60_000 }, async () => {
        const pidFile = path.join(scratch, "cut.pid");
        const call = exec({ command: ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 60`], timeoutSeconds: 120 });
        call.catch(() => {}); // checked below
        await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 15_000, "the command to start");
        const pid = Number(readFileSync(pidFile, "utf8"));
        assert.ok(isAlive(pid));

        const cutAt = Date.now();
        for (const connection of hostConnections) connection.close("test cut");
        await assert.rejects(call, (error) => {
            assert.ok(error instanceof RelayTransportError);
            assert.equal(error.kind, "closed");
            assert.match(error.message, /outcome is unknown/);
            return true;
        });
        assert.ok(Date.now() - cutAt < 15_000, "caller took too long to notice the cut");
        await waitFor(() => !isAlive(pid), 5000, `command ${pid} to be killed`);
    });

    // ---- whose sessions the host serves ---------------------------------------

    test(`${name}: ready carries the host's allow list`, { timeout: 60_000 }, async () => {
        const serves = await client.serves();
        assert.equal(serves.anyOwner, false);
        assert.deepEqual(serves.emails, ["alice@example.com"]);
        assert.deepEqual(serves.objectIds, [BOB_OID]);
    });

    test(`${name}: an owner listed by object id runs, whatever the id's case`, { timeout: 60_000 }, async () => {
        const { result } = await client.exec({ session: BOB, command: ["echo", "bob"] });
        assert.equal(result.status, "exited");
        assert.equal(result.stdout.text, "bob\n");
    });

    const refused = [
        ["an owner not on the list", MALLORY],
        ["a listed email under a non-Entra provider", DEV_ALICE],
        ["a call with no session owner", undefined],
    ];

    for (const [label, session] of refused) {
        test(`${name}: the caller refuses ${label} and sends nothing`, { timeout: 60_000 }, async () => {
            const marker = path.join(scratch, `ran-${randomBytes(4).toString("hex")}`);
            const logBefore = hostLog.length;
            await assert.rejects(client.exec({ session, command: ["touch", marker] }), (error) => {
                assert.ok(error instanceof RelayAccessError, `expected RelayAccessError, got ${error}`);
                assert.match(error.message, /does not serve/);
                return true;
            });
            await sleep(300);
            const seen = hostLog.slice(logBefore).filter((line) => /^(exec|rejected) /.test(line));
            assert.deepEqual(seen, [], "the request reached the host");
            assert.equal(existsSync(marker), false, "the command ran");
        });
    }

    for (const [label, session] of refused) {
        test(`${name}: a trusted caller that skips the owner check still gets ${label} rejected by the host`, { timeout: 60_000 }, async () => {
            const marker = path.join(scratch, `ran-${randomBytes(4).toString("hex")}`);
            const raw = await rawCaller();
            await raw.auth(OUR_CLUSTER);
            await raw.next("ready");
            await raw.connection.send(encodeMessage({ type: "exec", id: `raw-${randomBytes(4).toString("hex")}`, session, command: ["touch", marker], timeoutSeconds: 5 }));
            const result = await raw.next("exec_result");
            raw.connection.close();
            assert.equal(result.status, "rejected");
            await sleep(200);
            assert.equal(existsSync(marker), false, "the rejected command ran anyway");
        });
    }

    test(`${name}: the next call opens a new connection`, { timeout: 60_000 }, async () => {
        const { result } = await exec({ command: ["echo", "back"] });
        assert.equal(result.stdout.text, "back\n");
    });
}
