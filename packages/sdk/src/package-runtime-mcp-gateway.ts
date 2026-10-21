import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { SupervisedPackageRuntime } from "./package-runtime-supervisor.js";

/** Trusted local MCP transport. Neither commands nor package code enter the SDK parent. */
export class PackageMcpGateway {
    private server?: Server;
    private opening?: Promise<number>;
    private tokens = new Map<string, { runtime: SupervisedPackageRuntime; sessionId: string; name: string }>();
    private bindings = new WeakMap<SupervisedPackageRuntime, Map<string, string>>();
    async configuration(runtime: SupervisedPackageRuntime, sessionId: string, name: string): Promise<Record<string, unknown>> {
        await runtime.authorizeMcp(sessionId, name);
        const port = await (this.opening ??= this.open());
        let bindings = this.bindings.get(runtime);
        if (!bindings) { bindings = new Map(); this.bindings.set(runtime, bindings); }
        const key = JSON.stringify([sessionId, name]);
        const token = bindings.get(key) ?? randomBytes(32).toString("hex");
        bindings.set(key, token);
        this.tokens.set(token, { runtime, sessionId, name });
        return { type: "http", url: `http://127.0.0.1:${port}/${token}`, tools: ["*"] };
    }
    private open(): Promise<number> {
        this.server = createServer(async (req, res) => {
            const binding = this.tokens.get(req.url?.slice(1) ?? "");
            if (!binding) { res.writeHead(404).end(); return; }
            if (req.method !== "POST") { res.writeHead(405).end(); return; }
            let id: unknown = null;
            try {
                const chunks: Buffer[] = [];
                let length = 0;
                for await (const chunk of req) {
                    length += chunk.length;
                    if (length > 1_000_000) throw new Error("MCP request too large");
                    chunks.push(chunk);
                }
                const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                id = request.id ?? null;
                const { runtime, sessionId, name } = binding;
                await runtime.authorizeMcp(sessionId, name);
                let result: unknown;
                if (request.method === "initialize") {
                    await runtime.startMcp(sessionId, name);
                    result = { protocolVersion: "2024-11-05", capabilities: { tools: {} },
                        serverInfo: { name: "pilotswarm-supervised-package", version: "1" } };
                } else if (request.method === "tools/list" || request.method === "tools/call") {
                    result = await runtime.callMcp(sessionId, name, request.method, request.params ?? {});
                } else if (request.method === "ping") result = {};
                else if (request.method === "notifications/initialized" && id === null) {
                    res.writeHead(202).end(); return;
                } else throw new Error("Unsupported supervised MCP transport method");
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
            } catch (error) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000,
                    message: error instanceof Error ? error.message : String(error) } }));
            }
        });
        this.server.requestTimeout = 35_000;
        this.server.headersTimeout = 5000;
        return new Promise((resolve, reject) => {
            this.server!.once("error", reject);
            this.server!.listen(0, "127.0.0.1", () => {
                resolve((this.server!.address() as { port: number }).port);
            });
        });
    }
    async close(): Promise<void> {
        this.tokens.clear();
        this.bindings = new WeakMap();
        const server = this.server;
        this.server = undefined;
        this.opening = undefined;
        if (!server) return;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}
