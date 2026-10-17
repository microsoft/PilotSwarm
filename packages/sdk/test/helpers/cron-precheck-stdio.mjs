import readline from "node:readline";

readline.createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    let result;
    if (message.method === "initialize") {
        result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "queue", version: "1" } };
    } else if (message.method === "tools/list") {
        result = { tools: [{ name: "queue_status", inputSchema: { type: "object" } }] };
    } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(), value: process.env.PRECHECK_FIXTURE_VALUE, pid: process.pid }) }] };
    } else result = {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
