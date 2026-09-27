/**
 * Caller end of the exec protocol. This is what a PilotSwarm tool would use.
 *
 * On connect:
 * 1. Prove which cluster this is (sign the host's challenge)
 * 2. Check the host: its key must match the key pinned for this endpoint,
 *    or, on first contact, its activation secret must activate it
 * 3. Send host_ok, then (optionally) a fresh relay credential for the host
 * 4. Learn whose sessions the host serves
 *
 * It never runs anything locally. If the relay is unreachable, refuses the
 * cluster, the host fails its check, or the link drops, the call fails with a
 * RelayTransportError that says so. No command is sent before step 3.
 */

import { randomUUID } from "node:crypto";
import { checkHostProof, newChallenge, type ClusterSigner } from "./auth.js";
import type { HostRegistry } from "./host-registry.js";
import {
    PROTOCOL_VERSION,
    checkExecRequest,
    decodeMessage,
    encodeMessage,
    type ExecRequest,
    type ExecResult,
    type HostSummary,
    type ReadyMessage,
    type ServedOwners,
    type SessionContext,
    type SessionOwner,
} from "./protocol.js";
import { OwnerAllowList } from "./owner-allowlist.js";
import { RelayTransportError, type RelayConnection, type RelayTransport } from "./transport.js";

/** The host does not serve this session's owner. Thrown before anything is sent to the host. */
export class RelayAccessError extends Error {
    constructor(
        readonly owner: SessionOwner | undefined,
        readonly serves: ServedOwners,
    ) {
        const who = owner ? `sessions owned by ${owner.email ?? owner.subject} (${owner.provider})` : "sessions with no known owner";
        super(`this relay host does not serve ${who}; it serves: ${[...serves.emails, ...serves.objectIds].join(", ")}`);
        this.name = "RelayAccessError";
    }
}

export interface ExecCall {
    /** The session this command runs for. A host with an allow list rejects calls without it. */
    session?: SessionContext;
    command: string[];
    cwd?: string;
    timeoutSeconds?: number;
    stdin?: string;
}

export interface ExecClientOptions {
    /** Where the cluster keeps each host's pinned key and pending activation. */
    hostRegistry: HostRegistry;
    /** Makes a fresh relay credential for this host's endpoint; pushed after every handshake. */
    grantUpdate?: () => Promise<unknown> | unknown;
    /** How long the whole handshake (hello, auth, ready) may take. Default 15 s. */
    handshakeTimeoutMs?: number;
    /** Extra time past the command timeout before giving up on a result. Default 15 s. */
    resultGraceMs?: number;
    /** Command timeout when a call does not set one. Default 60 s. */
    defaultTimeoutSeconds?: number;
}

interface Pending {
    resolve: (result: ExecResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

interface Session {
    connection: RelayConnection;
    host: HostSummary;
    serves: ServedOwners;
    /** Built from `serves`; undefined when the host serves any owner. */
    allowed: OwnerAllowList | undefined;
}

export class RelayExecClient {
    private session: Promise<Session> | undefined;
    private liveConnection: RelayConnection | undefined;
    private readonly pending = new Map<string, Pending>();
    private readonly handshakeTimeoutMs: number;
    private readonly resultGraceMs: number;
    private readonly defaultTimeoutSeconds: number;

    constructor(
        private readonly transport: RelayTransport,
        /** Signs the host's challenge as this cluster. */
        private readonly signer: ClusterSigner,
        private readonly options: ExecClientOptions,
    ) {
        this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
        this.resultGraceMs = options.resultGraceMs ?? 15_000;
        this.defaultTimeoutSeconds = options.defaultTimeoutSeconds ?? 60;
    }

    /** Connects if needed and returns what the host said about itself. */
    async host(): Promise<HostSummary> {
        return (await this.connected()).host;
    }

    /** Connects if needed and returns whose sessions the host serves (from its ready message). */
    async serves(): Promise<ServedOwners> {
        return (await this.connected()).serves;
    }

    async exec(call: ExecCall): Promise<{ host: HostSummary; result: ExecResult }> {
        const request: ExecRequest = {
            type: "exec",
            id: randomUUID(),
            session: call.session,
            command: call.command,
            cwd: call.cwd,
            timeoutSeconds: call.timeoutSeconds ?? this.defaultTimeoutSeconds,
            stdin: call.stdin,
        };
        const problem = checkExecRequest(request);
        if (problem) throw new TypeError(problem);

        const { connection, host, serves, allowed } = await this.connected();
        // Check here so a command for an owner the host does not serve is never sent.
        if (!serves.anyOwner && !allowed?.allows(call.session?.owner)) {
            throw new RelayAccessError(call.session?.owner, serves);
        }
        const result = new Promise<ExecResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(request.id);
                reject(new RelayTransportError("closed", "no result from the relay host in time; the command's outcome is unknown"));
            }, request.timeoutSeconds * 1000 + this.resultGraceMs);
            this.pending.set(request.id, { resolve, reject, timer });
        });
        try {
            await connection.send(encodeMessage(request));
        } catch (error) {
            this.settle(request.id, error as Error);
            throw error;
        }
        return { host, result: await result };
    }

    close(): void {
        void this.session?.then((session) => session.connection.close("caller closed")).catch(() => {});
        this.session = undefined;
    }

    private connected(): Promise<Session> {
        if (!this.session) {
            this.session = this.open();
            this.session.catch(() => {
                this.session = undefined;
            });
        }
        return this.session;
    }

    private async open(): Promise<Session> {
        const connection = await this.transport.connect();
        this.liveConnection = connection;
        const endpointId = this.transport.endpointId;
        const hostChallenge = newChallenge();
        return new Promise<Session>((resolve, reject) => {
            let settled = false;
            const fail = (error: RelayTransportError, closeReason: string) => {
                clearTimeout(handshakeTimer);
                settled = true;
                reject(error);
                connection.close(closeReason);
            };
            const refuseHost = (reason: string) => {
                void connection
                    .send(encodeMessage({ type: "host_refused", reason }))
                    .catch(() => {})
                    .finally(() => fail(new RelayTransportError("unauthorized", `relay host failed its check: ${reason}`), "host refused"));
            };
            const handshakeTimer = setTimeout(
                () => fail(new RelayTransportError("protocol", "relay host did not finish the handshake in time"), "handshake timeout"),
                this.handshakeTimeoutMs,
            );

            const checkHost = async (message: ReadyMessage) => {
                const hostKey = message.hostKey;
                if (!hostKey || typeof hostKey.fingerprint !== "string" || typeof hostKey.publicKeyPem !== "string") {
                    refuseHost("sent no host key");
                    return;
                }
                const proof = { host: hostKey.fingerprint, cluster: this.signer.fingerprint, endpointId, challenge: hostChallenge };
                const pinned = await this.options.hostRegistry.pinnedHostKey(endpointId);
                let activated = false;
                if (pinned) {
                    if (!checkHostProof(pinned, proof, message.signature)) {
                        refuseHost("its key does not match the key pinned for this endpoint");
                        return;
                    }
                } else {
                    if (typeof message.activationSecret !== "string") {
                        refuseHost("it is not activated and sent no activation secret");
                        return;
                    }
                    // Check the signature first, so a bad proof never uses up the secret.
                    if (!checkHostProof(hostKey.publicKeyPem, proof, message.signature)) {
                        refuseHost("its signature does not match the key it sent");
                        return;
                    }
                    const result = await this.options.hostRegistry.activate(endpointId, message.activationSecret, hostKey.publicKeyPem, message.host);
                    if (!result.ok) {
                        refuseHost(result.reason);
                        return;
                    }
                    activated = true;
                }

                let allowed: OwnerAllowList | undefined;
                try {
                    allowed = OwnerAllowList.fromServed(message.serves);
                } catch (error) {
                    fail(new RelayTransportError("protocol", `relay host sent a bad allow list: ${(error as Error).message}`), "bad ready");
                    return;
                }
                await connection.send(encodeMessage({ type: "host_ok", activated }));
                if (this.options.grantUpdate) {
                    const grant = await this.options.grantUpdate();
                    await connection.send(encodeMessage({ type: "grant_update", grant }));
                }
                clearTimeout(handshakeTimer);
                settled = true;
                resolve({ connection, host: message.host, serves: message.serves, allowed });
            };

            connection.onFrame((frame) => {
                let message;
                try {
                    message = decodeMessage(frame);
                } catch {
                    connection.close("protocol error");
                    return;
                }
                if (message.type === "hello" && !settled) {
                    if (message.protocolVersion !== PROTOCOL_VERSION) {
                        fail(new RelayTransportError("protocol", `relay host speaks protocol ${message.protocolVersion}, expected ${PROTOCOL_VERSION}`), "protocol version");
                        return;
                    }
                    // Prove which cluster this is. The signature names the endpoint we dialed.
                    const signature = this.signer.signChallenge(endpointId, message.challenge);
                    connection
                        .send(encodeMessage({ type: "auth", cluster: this.signer.fingerprint, signature, challenge: hostChallenge }))
                        .catch(() => fail(new RelayTransportError("closed", "could not send auth"), "auth send failed"));
                } else if (message.type === "auth_failed") {
                    fail(new RelayTransportError("unauthorized", `relay host refused this cluster: ${message.reason}`), "auth failed");
                } else if (message.type === "ready" && !settled) {
                    checkHost(message).catch((error: Error) =>
                        fail(new RelayTransportError("protocol", `host check failed: ${error.message}`), "host check error"),
                    );
                } else if (message.type === "exec_result") {
                    const pending = this.pending.get(message.id);
                    if (!pending) return; // late or unknown result: never commit it
                    this.pending.delete(message.id);
                    clearTimeout(pending.timer);
                    pending.resolve(message);
                }
            });

            connection.onClose((info) => {
                clearTimeout(handshakeTimer);
                // Only forget the session if a newer connection has not replaced it.
                if (this.liveConnection === connection) {
                    this.liveConnection = undefined;
                    this.session = undefined;
                }
                const error = new RelayTransportError(
                    "closed",
                    `relay connection closed (code ${info.code}${info.reason ? `: ${info.reason}` : ""}); the command's outcome is unknown`,
                );
                if (!settled) reject(error);
                for (const id of [...this.pending.keys()]) this.settle(id, error);
            });
        });
    }

    private settle(id: string, error: Error): void {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
    }
}
