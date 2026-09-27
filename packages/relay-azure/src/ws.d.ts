// The parts of the `ws` package this spike uses. `@types/ws` is not installed
// in the monorepo, and adding it would change the shared lockfile.
declare module "ws" {
    import type { ClientRequest, IncomingMessage } from "node:http";
    import { EventEmitter } from "node:events";

    interface ClientOptions {
        handshakeTimeout?: number;
        perMessageDeflate?: boolean;
        maxPayload?: number;
    }

    class WebSocket extends EventEmitter {
        static readonly CONNECTING: 0;
        static readonly OPEN: 1;
        static readonly CLOSING: 2;
        static readonly CLOSED: 3;
        constructor(address: string, options?: ClientOptions);
        readonly readyState: 0 | 1 | 2 | 3;
        binaryType: "nodebuffer" | "arraybuffer" | "fragments";
        send(data: string | Uint8Array, options: { binary?: boolean }, callback: (error?: Error) => void): void;
        send(data: string | Uint8Array, callback?: (error?: Error) => void): void;
        ping(data?: Uint8Array): void;
        close(code?: number, reason?: string): void;
        terminate(): void;

        on(event: "open", listener: () => void): this;
        on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
        on(event: "close", listener: (code: number, reason: Buffer) => void): this;
        on(event: "error", listener: (error: Error) => void): this;
        on(event: "pong", listener: () => void): this;
        on(event: "unexpected-response", listener: (request: ClientRequest, response: IncomingMessage) => void): this;
        once(event: "open", listener: () => void): this;
        once(event: "error", listener: (error: Error) => void): this;
        once(event: "unexpected-response", listener: (request: ClientRequest, response: IncomingMessage) => void): this;
    }

    export default WebSocket;
}
