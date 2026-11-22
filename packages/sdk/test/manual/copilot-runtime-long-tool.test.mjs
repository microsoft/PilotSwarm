import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

const hostToolDurationMs = 30 * 60 * 1_000 + 5_000;
const home = await mkdtemp(join(tmpdir(), "pilotswarm-long-tool-"));
let requests = 0;
const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume */ }
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(requests === 1 ? {
        id: `long-tool-${requests}`, object: "chat.completion", model: "fixture-model",
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{
            id: "long-host-tool", type: "function", function: { name: "long_host_tool", arguments: "{}" },
        }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } : {
        id: `long-tool-${requests}`, object: "chat.completion", model: "fixture-model",
        choices: [{ index: 0, message: { role: "assistant", content: "The long host tool completed." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const client = new CopilotClient({
    useLoggedInUser: false,
    env: { ...process.env, COPILOT_HOME: home },
    logLevel: "error",
    connection: RuntimeConnection.forStdio(),
});
const startedAt = Date.now();
try {
    const provider = { type: "openai", wireApi: "completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-key" };
    const session = await client.createSession({
        model: "fixture-model",
        provider,
        onPermissionRequest: () => ({ kind: "approved" }),
        tools: [{
            name: "long_host_tool",
            description: "Wait past the former 30-minute host-tool deadline.",
            parameters: { type: "object", properties: {} },
            handler: async () => { await delay(hostToolDurationMs); return "completed"; },
        }],
    });
    const result = await session.sendAndWait({ prompt: "Call long_host_tool, then report when it completes." }, hostToolDurationMs + 120_000);
    assert.match(result.data.content, /completed/i);
    assert.ok(Date.now() - startedAt >= hostToolDurationMs);
    assert.equal((await client.getStatus()).version, "1.0.112");
    console.log(JSON.stringify({ status: "PASS", runtime: "1.0.112", hostToolDurationMs, elapsedMs: Date.now() - startedAt }));
} finally {
    await client.stop().catch(() => undefined);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
}
