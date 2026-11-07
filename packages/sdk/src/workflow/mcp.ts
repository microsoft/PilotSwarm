/**
 * MCP server tools for workflow scripts.
 *
 * An agent session reaches its MCP servers through the Copilot CLI, which
 * holds the connections. A workflow session has no CLI session, so the worker
 * connects to the same servers itself: the deployment's default MCP set that
 * a generic agent session gets. A script calls a tool as `<server>/<tool>`.
 *
 * Connections are opened on a node's first call to a server and closed when
 * the node ends, so a server sees one short session per node that uses it.
 */

/** The tool name a script uses for an MCP tool. */
export function scriptMcpToolName(server: string, tool: string): string {
    return `${server}/${tool}`;
}

export function parseScriptMcpToolName(name: string): { server: string; tool: string } | null {
    const slash = name.indexOf("/");
    if (slash <= 0 || slash === name.length - 1) return null;
    return { server: name.slice(0, slash), tool: name.slice(slash + 1) };
}

/** Whether a server config admits a tool by its `tools` list ("*" admits all). */
export function mcpConfigAllowsTool(config: { tools?: unknown }, tool: string): boolean {
    const tools = Array.isArray(config?.tools) ? config.tools : ["*"];
    return tools.includes("*") || tools.includes(tool);
}

/** What a script gets back from an MCP tool: structured content, joined text, or the raw content list. */
export function scriptMcpResult(result: any): unknown {
    const content = Array.isArray(result?.content) ? result.content : [];
    const textOf = () => content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
    if (result?.isError) {
        throw new Error(textOf() || "the MCP tool reported an error");
    }
    if (result?.structuredContent !== undefined) return result.structuredContent;
    if (content.length > 0 && content.every((part: any) => part?.type === "text")) return textOf();
    if (content.length === 0 && result?.toolResult !== undefined) return result.toolResult;
    return content;
}

type McpClient = {
    connect(transport: unknown): Promise<void>;
    callTool(params: { name: string; arguments?: Record<string, unknown> }, resultSchema?: unknown, options?: { timeout?: number }): Promise<any>;
    listTools(params?: unknown, options?: { timeout?: number }): Promise<{ tools: Array<{ name: string; description?: string }> }>;
    close(): Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 60_000;

async function openClient(name: string, config: any): Promise<McpClient> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "pilotswarm-workflow", version: "1.0.0" }) as unknown as McpClient;
    const type = config?.type ?? (config?.command ? "stdio" : "http");
    if (type === "stdio" || type === "local") {
        const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/sdk/client/stdio.js");
        await client.connect(new StdioClientTransport({
            command: String(config.command),
            args: Array.isArray(config.args) ? config.args.map(String) : [],
            env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
            ...(config.cwd ? { cwd: String(config.cwd) } : {}),
            stderr: "ignore",
        }));
        return client;
    }
    const url = new URL(String(config?.url ?? ""));
    const requestInit = config?.headers ? { headers: config.headers as Record<string, string> } : undefined;
    if (type === "sse") {
        const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
        await client.connect(new SSEClientTransport(url, requestInit ? { requestInit } : undefined));
        return client;
    }
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    await client.connect(new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined));
    void name;
    return client;
}

/** Connections to the MCP servers one node may use. Close it when the node ends. */
export class ScriptMcpConnections {
    private readonly clients = new Map<string, Promise<McpClient>>();

    constructor(private readonly servers: Record<string, any>) {}

    get serverNames(): string[] {
        return Object.keys(this.servers).sort();
    }

    has(server: string): boolean {
        return Object.hasOwn(this.servers, server);
    }

    private client(server: string): Promise<McpClient> {
        let pending = this.clients.get(server);
        if (!pending) {
            pending = openClient(server, this.servers[server]);
            this.clients.set(server, pending);
            pending.catch(() => this.clients.delete(server));
        }
        return pending;
    }

    async call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
        const config = this.servers[server];
        if (!config) throw new Error(`MCP server '${server}' is not available to workflow scripts.`);
        if (!mcpConfigAllowsTool(config, tool)) {
            throw new Error(`Tool '${tool}' is not enabled on MCP server '${server}'.`);
        }
        const client = await this.client(server);
        const timeout = Number(config.timeout) > 0 ? Number(config.timeout) : DEFAULT_TIMEOUT_MS;
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout });
        return scriptMcpResult(result);
    }

    /** The tools a server offers that its config admits, as `<server>/<tool>` names. */
    async listTools(server: string): Promise<Array<{ name: string; description?: string }>> {
        const config = this.servers[server];
        if (!config) throw new Error(`MCP server '${server}' is not available to workflow scripts.`);
        const client = await this.client(server);
        const listed = await client.listTools(undefined, { timeout: DEFAULT_TIMEOUT_MS });
        return (listed.tools ?? [])
            .filter((tool) => mcpConfigAllowsTool(config, tool.name))
            .map((tool) => ({ name: scriptMcpToolName(server, tool.name), ...(tool.description ? { description: tool.description } : {}) }));
    }

    async close(): Promise<void> {
        const pending = [...this.clients.values()];
        this.clients.clear();
        await Promise.all(pending.map(async (client) => {
            try { await (await client).close(); } catch { /* already gone */ }
        }));
    }
}
