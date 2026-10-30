// A tiny stdio MCP server for the workflow tests: `add` returns a number as
// text, `info` returns structured content, `fail` reports a tool error, and
// `secret` exists so a config's tools list can be shown to exclude it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "calc", version: "1.0.0" });
server.registerTool("add", { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
server.registerTool("info", { description: "Structured info", inputSchema: {}, outputSchema: { pid: z.number(), env: z.string().nullable() } },
    async () => {
        const structured = { pid: process.pid, env: process.env.CALC_LABEL ?? null };
        return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
    });
server.registerTool("fail", { description: "Always fails", inputSchema: {} },
    async () => ({ isError: true, content: [{ type: "text", text: "calc refused" }] }));
server.registerTool("secret", { description: "Not enabled by the tests' config", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "secret" }] }));
await server.connect(new StdioServerTransport());
