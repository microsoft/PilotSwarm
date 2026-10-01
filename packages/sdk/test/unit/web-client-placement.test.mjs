import assert from "node:assert/strict";
import test from "node:test";
import { PilotSwarmClient } from "../../dist/client.js";

function clientWithFakeApi() {
    const calls = [];
    const api = {
        async start() {},
        async health() {},
        async stop() {},
        async call(name, params) {
            calls.push({ name, params });
            return { sessionId: `session-${calls.length}` };
        },
    };
    const client = new PilotSwarmClient({
        apiUrl: "https://pilotswarm.example.test",
        api,
    });
    return { client, calls };
}

test("web session creation forwards devbox placement", async () => {
    const { client, calls } = clientWithFakeApi();

    await client.createSession({
        model: "github-copilot:gpt-5",
        compute: "devbox",
        repo: "sample-repo",
    });
    await client.createSessionForAgent("reviewer", {
        model: "github-copilot:gpt-5",
        compute: "devbox",
        repo: "sample-repo",
    });

    assert.deepEqual(calls, [{
        name: "createSession",
        params: {
            model: "github-copilot:gpt-5",
            reasoningEffort: undefined,
            contextTier: undefined,
            groupId: undefined,
            repo: "sample-repo",
            compute: "devbox",
        },
    }, {
        name: "createSessionForAgent",
        params: {
            agentName: "reviewer",
            model: "github-copilot:gpt-5",
            reasoningEffort: undefined,
            contextTier: undefined,
            title: undefined,
            splash: undefined,
            splashMobile: undefined,
            initialPrompt: undefined,
            groupId: undefined,
            repo: "sample-repo",
            compute: "devbox",
        },
    }]);
});
