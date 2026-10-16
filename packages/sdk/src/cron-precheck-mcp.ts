import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPServerConfig } from "./mcp-loader.js";

/**
 * A fresh, bounded connection per call: no stale credentials or shared
 * session state, and no Copilot client, prompt hydration or model request.
 */
export async function callCronPrecheckMcpTool(
    servers: Record<string, MCPServerConfig>,
    signal: AbortSignal,
    server: string,
    tool: string,
    args?: Record<string, unknown>,
): Promise<CallToolResult> {
    signal.throwIfAborted();
    if (!server || !tool || !Object.hasOwn(servers, server)) {
        throw new Error("Cron precheck MCP server is unavailable or unauthorized");
    }
    const config = servers[server];
    if (!Array.isArray(config.tools) || !config.tools.some(name => name === "*" || name === tool)) {
        throw new Error("Cron precheck MCP tool is not authorized");
    }
    const client = new Client({ name: "pilotswarm-cron-precheck", version: "1.0.0" }, { capabilities: {} });
    // The evaluator records errors in operator-visible events. Do not expose
    // transport messages there: they may contain auth headers or signed URLs.
    let closeFailure = false;
    const close = () => client.close().catch(() => { closeFailure = true; });
    const abort = () => { void close(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
        signal.throwIfAborted();
        let transport: Transport;
        if (config.type === "http") {
            transport = new StreamableHTTPClientTransport(new URL(config.url), {
                requestInit: { headers: config.headers },
            });
        } else if (config.type === "sse") {
            transport = new SSEClientTransport(new URL(config.url), {
                requestInit: { headers: config.headers },
                eventSourceInit: {
                    fetch: (url, init) => {
                        const headers = new Headers(init?.headers);
                        for (const [name, value] of Object.entries(config.headers ?? {})) headers.set(name, value);
                        return fetch(url, { ...init, headers });
                    },
                },
            });
        } else if (config.type === undefined || config.type === "local" || config.type === "stdio") {
            const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
            transport = new StdioClientTransport({
                command: config.command, args: config.args, env: { ...env, ...config.env },
                cwd: config.cwd, stderr: "ignore",
            });
        } else {
            throw new Error("Unsupported cron precheck MCP transport");
        }
        const options = { signal, ...(config.timeout !== undefined ? { timeout: config.timeout } : {}) };
        await client.connect(transport, options);
        const result = CallToolResultSchema.parse(await client.callTool({ name: tool, arguments: args }, CallToolResultSchema, options));
        if (result.isError) throw new Error("MCP tool returned an error");
        return result;
    } catch {
        throw new Error("Cron precheck MCP call failed; run the normal cycle");
    } finally {
        signal.removeEventListener("abort", abort);
        await close();
        if (closeFailure) throw new Error("Cron precheck MCP connection cleanup failed; run the normal cycle");
    }
}
