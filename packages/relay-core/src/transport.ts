/**
 * The contract between PilotSwarm and a relay service.
 *
 * Both sides dial out to the relay service. Neither side listens on a local
 * port. A transport carries whole binary frames in both directions and
 * nothing else: it does not know about commands, sessions, or hosts. The
 * layers above it (protocol.ts, exec-client.ts, exec-host.ts) are the same
 * for every relay service.
 */

export type RelayErrorKind =
    /** The credential is missing, expired, or lacks the right for this action. */
    | "unauthorized"
    /** The relay endpoint does not exist. */
    | "not_found"
    /** No host is connected to the relay endpoint. */
    | "no_listener"
    /** The relay service could not be reached. */
    | "network"
    /** The connection is closed. */
    | "closed"
    /** The other side sent something this code does not understand. */
    | "protocol";

export class RelayTransportError extends Error {
    constructor(
        readonly kind: RelayErrorKind,
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = "RelayTransportError";
    }
}

export interface RelayCloseInfo {
    /** WebSocket close code. 1000 is a normal close; 1006 means the link was lost. */
    code: number;
    reason: string;
}

/** One open connection between one caller and one host. */
export interface RelayConnection {
    readonly id: string;
    readonly isOpen: boolean;
    /** Resolves once the frame is handed to the network. */
    send(frame: Uint8Array): Promise<void>;
    /** Frames that arrive before a handler is added are held and then delivered in order. */
    onFrame(handler: (frame: Uint8Array) => void): void;
    /** Fires once, whichever side closed the connection. */
    onClose(handler: (info: RelayCloseInfo) => void): void;
    close(reason?: string): void;
}

/** The host side: one long-lived outbound registration that receives connections. */
export interface RelayListener {
    onConnection(handler: (connection: RelayConnection) => void): void;
    /** Fires once if the registration is lost. The host decides whether to listen again. */
    onClose(handler: (info: RelayCloseInfo) => void): void;
    close(): void;
}

export interface RelayTransport {
    /** Short name for logs, for example "azure-relay". */
    readonly provider: string;
    /**
     * The endpoint this transport listens on or connects to, as a stable string.
     * Both ends of one connection must see the same value: the cluster signs it
     * during the handshake, so a signature made for one host cannot be replayed
     * to another.
     */
    readonly endpointId: string;
    /** Host side. Dials out and waits for callers. */
    listen(): Promise<RelayListener>;
    /** Caller side. Dials out and joins a waiting host. */
    connect(): Promise<RelayConnection>;
}

/**
 * Handler bookkeeping shared by every adapter: holds early frames, fires the
 * close handlers exactly once, and marks the connection closed.
 */
export abstract class BaseRelayConnection implements RelayConnection {
    private readonly frameHandlers: Array<(frame: Uint8Array) => void> = [];
    private readonly closeHandlers: Array<(info: RelayCloseInfo) => void> = [];
    private readonly heldFrames: Uint8Array[] = [];
    private closeInfo: RelayCloseInfo | undefined;

    constructor(readonly id: string) {}

    get isOpen(): boolean {
        return this.closeInfo === undefined;
    }

    abstract send(frame: Uint8Array): Promise<void>;
    abstract close(reason?: string): void;

    onFrame(handler: (frame: Uint8Array) => void): void {
        this.frameHandlers.push(handler);
        while (this.heldFrames.length > 0) handler(this.heldFrames.shift()!);
    }

    onClose(handler: (info: RelayCloseInfo) => void): void {
        if (this.closeInfo) {
            const info = this.closeInfo;
            queueMicrotask(() => handler(info));
            return;
        }
        this.closeHandlers.push(handler);
    }

    protected deliverFrame(frame: Uint8Array): void {
        if (!this.isOpen) return;
        if (this.frameHandlers.length === 0) {
            this.heldFrames.push(frame);
            return;
        }
        for (const handler of this.frameHandlers) handler(frame);
    }

    protected deliverClose(info: RelayCloseInfo): void {
        if (this.closeInfo) return;
        this.closeInfo = info;
        for (const handler of this.closeHandlers.splice(0)) handler(info);
    }
}
