import { createServer } from "node:http";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

const [home, sessionId, workingDirectory] = process.argv.slice(2);
const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
        id: "unclean-fixture",
        object: "chat.completion",
        model: "fixture-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Persisted before the unclean stop." }, finish_reason: "stop" }],
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
await client.start();
const session = await client.createSession({
    sessionId,
    model: "fixture-model",
    workingDirectory,
    provider: { type: "openai", wireApi: "completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-key" },
    onPermissionRequest: () => ({ kind: "approved" }),
});
await session.sendAndWait({ prompt: "Persist the handoff fixture." }, 20_000);
console.log("READY");
await new Promise(() => {});
