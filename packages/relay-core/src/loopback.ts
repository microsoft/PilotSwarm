/**
 * In-memory adapter for tests. Same contract as the Azure adapter, no network.
 * If the exec layer passes over this and over Azure with no code change, the
 * contract is doing its job.
 */

import { randomUUID } from "node:crypto";
import {
    BaseRelayConnection,
    RelayTransportError,
    type RelayCloseInfo,
    type RelayConnection,
    type RelayListener,
    type RelayTransport,
} from "./transport.js";

export class LoopbackTransport implements RelayTransport {
    readonly provider = "loopback";
    private listener: LoopbackListener | undefined;

    constructor(readonly endpointId: string = "loopback/default") {}

    async listen(): Promise<RelayListener> {
        if (this.listener?.isOpen) throw new RelayTransportError("protocol", "a host is already listening");
        this.listener = new LoopbackListener();
        return this.listener;
    }

    async connect(): Promise<RelayConnection> {
        const listener = this.listener;
        if (!listener?.isOpen) throw new RelayTransportError("no_listener", "no host is listening");
        const id = randomUUID();
        const callerSide = new LoopbackConnection(id);
        const hostSide = new LoopbackConnection(id);
        callerSide.peer = hostSide;
        hostSide.peer = callerSide;
        listener.deliver(hostSide);
        return callerSide;
    }

    /** Test hook: cut every open connection as if the network dropped (close code 1006). */
    dropAll(): void {
        this.listener?.dropAll();
    }
}

class LoopbackConnection extends BaseRelayConnection {
    peer: LoopbackConnection | undefined;

    send(frame: Uint8Array): Promise<void> {
        if (!this.isOpen) return Promise.reject(new RelayTransportError("closed", "relay connection is closed"));
        const copy = frame.slice();
        const peer = this.peer!;
        setImmediate(() => peer.receive(copy));
        return Promise.resolve();
    }

    close(reason = "closed"): void {
        this.end({ code: 1000, reason });
    }

    end(info: RelayCloseInfo): void {
        if (!this.isOpen) return;
        this.deliverClose(info);
        const peer = this.peer!;
        setImmediate(() => peer.end(info));
    }

    receive(frame: Uint8Array): void {
        this.deliverFrame(frame);
    }
}

class LoopbackListener implements RelayListener {
    private readonly connectionHandlers: Array<(connection: RelayConnection) => void> = [];
    private readonly closeHandlers: Array<(info: RelayCloseInfo) => void> = [];
    private readonly connections = new Set<LoopbackConnection>();
    isOpen = true;

    onConnection(handler: (connection: RelayConnection) => void): void {
        this.connectionHandlers.push(handler);
    }

    onClose(handler: (info: RelayCloseInfo) => void): void {
        this.closeHandlers.push(handler);
    }

    close(): void {
        if (!this.isOpen) return;
        this.isOpen = false;
        for (const handler of this.closeHandlers.splice(0)) handler({ code: 1000, reason: "listener closed" });
    }

    deliver(connection: LoopbackConnection): void {
        this.connections.add(connection);
        connection.onClose(() => this.connections.delete(connection));
        setImmediate(() => {
            for (const handler of this.connectionHandlers) handler(connection);
        });
    }

    dropAll(): void {
        for (const connection of this.connections) connection.end({ code: 1006, reason: "link lost" });
    }
}
