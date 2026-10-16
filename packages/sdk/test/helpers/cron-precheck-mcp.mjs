import http from "node:http";
import { once } from "node:events";

/** A real HTTP/SSE MCP protocol fixture; never calls a model. */
export async function startPrecheckMcpServer({ sse = false } = {}) {
    const state = { hasWork: false, calls: [], headers: [], fail: false, hang: false, malformed: false, unauthorized: false, hangInitialize: false };
    const streams = new Set();
    let stream;
    const server = http.createServer(async (req, res) => {
        if (req.method === "GET" && sse && req.url === "/sse") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
            res.write("event: endpoint\ndata: /messages\n\n");
            stream = res;
            streams.add(res);
            res.on("close", () => streams.delete(res));
            return;
        }
        if (req.method !== "POST") { res.writeHead(405).end(); return; }
        if (state.unauthorized) { res.writeHead(401).end(); return; }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const message = JSON.parse(Buffer.concat(chunks).toString());
        state.headers.push(req.headers);
        if (message.id === undefined) { res.writeHead(202).end(); return; }
        let result;
        if (message.method === "initialize") {
            if (state.hangInitialize) return;
            result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "queue", version: "1" } };
        } else if (message.method === "tools/list") {
            result = { tools: [{ name: "queue_status", inputSchema: { type: "object" } }] };
        } else if (message.method === "tools/call") {
            state.calls.push(message.params);
            if (state.hang) return;
            result = state.malformed ? { content: "invalid" } : {
                content: [{ type: "text", text: JSON.stringify({ hasWork: state.hasWork }) }],
                structuredContent: { hasWork: state.hasWork },
                ...(state.fail ? { isError: true } : {}),
            };
        } else result = {};
        const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        if (sse) {
            res.writeHead(202).end();
            stream.write(`event: message\ndata: ${reply}\n\n`);
        } else {
            res.writeHead(200, { "Content-Type": "application/json" }).end(reply);
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        state,
        config: { type: sse ? "sse" : "http", url: `http://127.0.0.1:${server.address().port}/${sse ? "sse" : "mcp"}`, tools: ["queue_status"] },
        close: async () => {
            for (const res of streams) res.end();
            server.closeAllConnections();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}
