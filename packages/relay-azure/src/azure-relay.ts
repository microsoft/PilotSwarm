/**
 * Azure Relay Hybrid Connections adapter.
 *
 * Wire protocol (learn.microsoft.com/azure/azure-relay/relay-hybrid-connections-protocol):
 *
 *   Host side:
 *   1. Open a "control" WebSocket to  wss://{ns}/$hc/{path}?sb-hc-action=listen&sb-hc-token=...
 *   2. When a caller arrives, Azure sends {"accept":{"address":...,"id":...}} on the control socket
 *   3. Open a second WebSocket to that address. It is now joined to the caller.
 *   4. Before the SAS token expires, send {"renewToken":{"token":...}} on the control socket.
 *
 *   Caller side:
 *   1. Open a WebSocket to  wss://{ns}/$hc/{path}?sb-hc-action=connect&sb-hc-token=...
 *      It is joined to a host once the host completes step 3.
 *
 * All sockets go out on port 443. The core only ever sees RelayTransport.
 */

import { createHmac, randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
    BaseRelayConnection,
    RelayTransportError,
    type GrantedTransport,
    type RelayCloseInfo,
    type RelayConnection,
    type RelayErrorKind,
    type RelayListener,
} from "pilotswarm-relay-core";

/**
 * Give the transport EITHER a SAS rule (keyName + key; it signs its own
 * tokens, used by the deployment) OR a ready-made token (used by a host,
 * which never holds a key).
 */
export interface AzureRelayConfig {
    /** Namespace host name, for example "myns.servicebus.windows.net". */
    namespace: string;
    /** Hybrid connection name. */
    path: string;
    /** SAS rule name. The host needs a rule with Listen; the caller needs one with Send. */
    keyName?: string;
    /** SAS rule key. */
    key?: string;
    /** A ready-made SAS token for this hybrid connection. */
    token?: string;
    /** Lifetime of each SAS token. Default one hour. */
    tokenTtlSeconds?: number;
    /** How often to ping each socket so NATs keep it open and dead links are found. Default 30 s. */
    pingIntervalMs?: number;
    /** How long to wait for a socket to open. Default 30 s. */
    handshakeTimeoutMs?: number;
    log?: (line: string) => void;
}

/** The Azure Relay grant a profile carries: where to listen, and a token to listen with. */
export interface AzureRelayGrant {
    namespace: string;
    path: string;
    listenToken: string;
    expiresAt: string;
}

export function parseAzureRelayGrant(grant: unknown): AzureRelayGrant {
    const g = grant as Partial<AzureRelayGrant> | null;
    if (!g || typeof g !== "object") throw new Error("the relay grant is not an object");
    for (const field of ["namespace", "path", "listenToken", "expiresAt"] as const) {
        if (typeof g[field] !== "string" || g[field]!.length === 0) throw new Error(`the relay grant has no ${field}`);
    }
    return g as AzureRelayGrant;
}

const DEFAULT_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * A Service Bus shared access signature:
 * sig = base64(HMAC-SHA256(key, urlencode(resourceUri) + "\n" + expiry)).
 */
export function createSasToken(
    resourceUri: string,
    keyName: string,
    key: string,
    ttlSeconds: number,
    nowMs: number = Date.now(),
): string {
    const expiry = Math.floor(nowMs / 1000) + ttlSeconds;
    const encodedUri = encodeURIComponent(resourceUri);
    const signature = createHmac("sha256", key).update(`${encodedUri}\n${expiry}`).digest("base64");
    return `SharedAccessSignature sr=${encodedUri}&sig=${encodeURIComponent(signature)}&se=${expiry}&skn=${encodeURIComponent(keyName)}`;
}

export class AzureRelayTransport implements GrantedTransport {
    readonly provider = "azure-relay";
    readonly namespace: string;
    readonly path: string;
    /** "{namespace}/{hybrid connection}", lower case. Signed by the cluster during the handshake. */
    readonly endpointId: string;
    // #private fields, so console.log and util.inspect never print a key or token.
    #tokenSource: () => string;
    /** True when this transport signs its own tokens and so renews on a timer. */
    readonly #signsOwnTokens: boolean;
    #activeListener: AzureRelayListener | undefined;
    readonly #log: ((line: string) => void) | undefined;
    private readonly tokenTtlSeconds: number;
    private readonly pingIntervalMs: number;
    private readonly handshakeTimeoutMs: number;

    constructor(config: AzureRelayConfig) {
        for (const field of ["namespace", "path"] as const) {
            if (!config[field]) throw new Error(`AzureRelayTransport: '${field}' is required`);
        }
        const signs = Boolean(config.keyName && config.key);
        if (signs === Boolean(config.token)) throw new Error("AzureRelayTransport: give either keyName + key, or token");
        this.namespace = config.namespace;
        this.path = config.path;
        this.endpointId = `${config.namespace}/${config.path}`.toLowerCase();
        this.#log = config.log;
        this.tokenTtlSeconds = config.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
        this.#signsOwnTokens = signs;
        if (signs) {
            const resourceUri = `http://${config.namespace}/${config.path}`;
            const { keyName, key } = config as { keyName: string; key: string };
            this.#tokenSource = () => createSasToken(resourceUri, keyName, key, this.tokenTtlSeconds);
        } else {
            const token = config.token!;
            this.#tokenSource = () => token;
        }
        this.pingIntervalMs = config.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
        this.handshakeTimeoutMs = config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    }

    async listen(): Promise<RelayListener> {
        const control = await this.open(this.endpointUrl("listen"), "listen");
        const renewEveryMs = this.#signsOwnTokens ? Math.max(10_000, this.tokenTtlSeconds * 750) : undefined;
        const listener = new AzureRelayListener(control, this, this.pingIntervalMs, renewEveryMs, this.#log);
        this.#activeListener = listener;
        listener.onClose(() => {
            if (this.#activeListener === listener) this.#activeListener = undefined;
        });
        return listener;
    }

    /**
     * A fresh grant pushed by the cluster. Must be for this same endpoint. The
     * open control socket switches to the new token at once.
     */
    refreshGrant(grant: unknown): void {
        const parsed = parseAzureRelayGrant(grant);
        if (`${parsed.namespace}/${parsed.path}`.toLowerCase() !== this.endpointId) {
            throw new Error(`the new grant is for ${parsed.namespace}/${parsed.path}, not ${this.endpointId}`);
        }
        const token = parsed.listenToken;
        this.#tokenSource = () => token;
        this.#activeListener?.renewNow();
    }

    async connect(): Promise<RelayConnection> {
        const id = randomUUID();
        const socket = await this.open(this.endpointUrl("connect", id), "connect");
        return new AzureRelayConnection(id, socket, this.pingIntervalMs);
    }

    /** @internal Used by the listener to join an arriving caller and to renew its token. */
    openAccepted(address: string): Promise<WebSocket> {
        return this.open(address, "accept");
    }

    /** @internal */
    newToken(): string {
        return this.#tokenSource();
    }

    private endpointUrl(action: "listen" | "connect", id: string = randomUUID()): string {
        const query = new URLSearchParams({
            "sb-hc-action": action,
            "sb-hc-id": id,
            "sb-hc-token": this.newToken(),
        });
        return `wss://${this.namespace}/$hc/${encodeURIComponent(this.path)}?${query}`;
    }

    private open(url: string, action: "listen" | "connect" | "accept"): Promise<WebSocket> {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(url, {
                handshakeTimeout: this.handshakeTimeoutMs,
                perMessageDeflate: false,
                maxPayload: 64 * 1024 * 1024,
            });
            socket.binaryType = "nodebuffer";
            let settled = false;
            const fail = (error: RelayTransportError) => {
                if (settled) return;
                settled = true;
                socket.terminate();
                reject(error);
            };
            socket.once("open", () => {
                settled = true;
                resolve(socket);
            });
            // Azure reports handshake failures as plain HTTP status codes.
            socket.once("unexpected-response", (request, response) => {
                const status = response.statusCode ?? 0;
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    if (body.length < 2000) body += chunk;
                });
                response.on("end", () => {
                    const detail = `${status} ${response.statusMessage ?? ""} ${body}`.replace(/\s+/g, " ").trim();
                    fail(new RelayTransportError(kindForStatus(status, detail), `Azure Relay ${action} failed: ${detail}`, status));
                    request.destroy();
                });
            });
            // `on`, not `once`: terminate() during a failed handshake can raise a
            // second error, and an unhandled "error" event crashes the process.
            socket.on("error", (error) => {
                fail(new RelayTransportError("network", `Azure Relay ${action} failed: ${error.message}`));
            });
        });
    }
}

/** `detail` is the status line plus the body; Azure puts the reason in the status line. */
function kindForStatus(status: number, detail: string): RelayErrorKind {
    if (status === 401 || status === 403) return "unauthorized";
    // Azure uses 404 for both "no host is connected" and "no such hybrid connection".
    if (status === 404) return /no listeners/i.test(detail) ? "no_listener" : "not_found";
    if (status === 502 || status === 504) return "no_listener";
    return "network";
}

/**
 * Pings a socket on a timer. Two pings in a row without a pong mean the link
 * is dead. One missed pong is tolerated: a spike run lost its registration to
 * a single missed pong on an otherwise healthy link.
 */
function keepAlive(socket: WebSocket, intervalMs: number): () => void {
    let unanswered = 0;
    socket.on("pong", () => {
        unanswered = 0;
    });
    const timer = setInterval(() => {
        if (unanswered >= 2) {
            socket.terminate();
            return;
        }
        unanswered += 1;
        socket.ping();
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}

class AzureRelayConnection extends BaseRelayConnection {
    constructor(id: string, private readonly socket: WebSocket, pingIntervalMs: number) {
        super(id);
        const stopKeepAlive = keepAlive(socket, pingIntervalMs);
        socket.on("message", (data) => this.deliverFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
        socket.on("close", (code, reason) => {
            stopKeepAlive();
            this.deliverClose({ code, reason: reason.toString("utf8") });
        });
        // A "close" event always follows an "error" event.
        socket.on("error", () => {});
    }

    send(frame: Uint8Array): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.isOpen || this.socket.readyState !== WebSocket.OPEN) {
                reject(new RelayTransportError("closed", "relay connection is closed"));
                return;
            }
            this.socket.send(frame, { binary: true }, (error) => {
                if (error) reject(new RelayTransportError("closed", `relay send failed: ${error.message}`));
                else resolve();
            });
        });
    }

    close(reason = "closed"): void {
        if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
            this.socket.close(1000, reason.slice(0, 120));
        }
    }
}

interface AcceptMessage {
    accept?: { address?: string; id?: string };
    request?: unknown;
}

class AzureRelayListener implements RelayListener {
    private readonly connectionHandlers: Array<(connection: RelayConnection) => void> = [];
    private readonly heldConnections: RelayConnection[] = [];
    private readonly closeHandlers: Array<(info: RelayCloseInfo) => void> = [];
    private closeInfo: RelayCloseInfo | undefined;
    private readonly stopTimers: () => void;

    constructor(
        private readonly control: WebSocket,
        private readonly transport: AzureRelayTransport,
        private readonly pingIntervalMs: number,
        /** Set when the transport signs its own tokens. A host with a pushed token renews when a new one arrives. */
        renewEveryMs: number | undefined,
        private readonly log: ((line: string) => void) | undefined,
    ) {
        const stopKeepAlive = keepAlive(control, pingIntervalMs);
        // Replace the token well before it expires, or Azure drops the control socket (code 1008).
        const renewTimer = renewEveryMs ? setInterval(() => this.renewToken(), renewEveryMs) : undefined;
        renewTimer?.unref();
        this.stopTimers = () => {
            stopKeepAlive();
            if (renewTimer) clearInterval(renewTimer);
        };

        control.on("message", (data, isBinary) => {
            if (isBinary) return;
            let message: AcceptMessage;
            try {
                message = JSON.parse(data.toString("utf8")) as AcceptMessage;
            } catch {
                this.log?.("azure-relay: ignored a control message that is not JSON");
                return;
            }
            if (message.accept?.address) {
                void this.accept(message.accept.address, message.accept.id ?? randomUUID());
            }
            // "request" messages only arrive when HTTP mode is on for the hybrid
            // connection. This spike creates it with HTTP mode off.
        });
        control.on("close", (code, reason) => {
            this.stopTimers();
            this.deliverClose({ code, reason: reason.toString("utf8") });
        });
        control.on("error", () => {});
    }

    onConnection(handler: (connection: RelayConnection) => void): void {
        this.connectionHandlers.push(handler);
        while (this.heldConnections.length > 0) handler(this.heldConnections.shift()!);
    }

    onClose(handler: (info: RelayCloseInfo) => void): void {
        if (this.closeInfo) {
            const info = this.closeInfo;
            queueMicrotask(() => handler(info));
            return;
        }
        this.closeHandlers.push(handler);
    }

    close(): void {
        this.stopTimers();
        if (this.control.readyState === WebSocket.OPEN || this.control.readyState === WebSocket.CONNECTING) {
            this.control.close(1000, "listener closed");
        }
    }

    private async accept(address: string, id: string): Promise<void> {
        try {
            const socket = await this.transport.openAccepted(address);
            const connection = new AzureRelayConnection(id, socket, this.pingIntervalMs);
            if (this.connectionHandlers.length === 0) {
                this.heldConnections.push(connection);
                return;
            }
            for (const handler of this.connectionHandlers) handler(connection);
        } catch (error) {
            this.log?.(`azure-relay: could not accept caller ${id}: ${(error as Error).message}`);
        }
    }

    renewNow(): void {
        this.renewToken();
    }

    private renewToken(): void {
        if (this.control.readyState !== WebSocket.OPEN) return;
        this.control.send(JSON.stringify({ renewToken: { token: this.transport.newToken() } }));
    }

    private deliverClose(info: RelayCloseInfo): void {
        if (this.closeInfo) return;
        this.closeInfo = info;
        for (const handler of this.closeHandlers.splice(0)) handler(info);
    }
}
