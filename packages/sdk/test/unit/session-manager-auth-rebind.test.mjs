import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "../../dist/session-manager.js";

class FakeCopilotSession {
    disconnected = false;

    on() {
        return () => {};
    }

    async disconnect() {
        this.disconnected = true;
    }
}

class FakeCopilotClient {
    configs = [];
    sessions = [];

    async createSession(config) {
        return this.capture(config);
    }

    async resumeSession(_sessionId, config) {
        return this.capture(config);
    }

    capture(config) {
        const session = new FakeCopilotSession();
        this.configs.push(config);
        this.sessions.push(session);
        return session;
    }

    async deleteSession() {}
}

const factStore = {
    async storeFact(input) { return { ...input, stored: true }; },
    async readFacts() { return { count: 0, facts: [] }; },
    async deleteFact(input) { return { ...input, deleted: true }; },
    async deleteSessionFactsForSession() { return 0; },
};

const catalog = {
    async getSession() { return null; },
    async getSessionEvents() { return []; },
    async getSessionEventsBefore() { return []; },
    async getDescendantSessionIds() { return []; },
    async recordEvents() {},
};

test("rotated stdio credentials recycle a warm Copilot session", async () => {
    const originalSpecs = process.env.CALLER_AUTH_ENV_TOKENS;
    const originalMode = process.env.CALLER_AUTH_MODE;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pilotswarm-rebind-"));
    let token = "token-one";
    try {
        process.env.CALLER_AUTH_ENV_TOKENS = "TEST_ACCESS_TOKEN=api://test";
        process.env.CALLER_AUTH_MODE = "devbox";
        const manager = new SessionManager(undefined, null, {
            baseMcpServers: {
                local: { command: "node", args: ["server.js"] },
            },
            callerTokenProvider: async () => token,
        }, stateDir);
        const client = new FakeCopilotClient();
        manager.client = client;
        manager.setFactStore(factStore);
        manager.setSessionCatalog(catalog);

        const config = { toolNames: [] };
        await manager.getOrCreate("auth-rebind-session", config, { turnIndex: 0 });
        assert.equal(
            client.configs[0].mcpServers.local.env.TEST_ACCESS_TOKEN,
            "token-one",
        );

        const sessionDir = path.join(stateDir, "auth-rebind-session");
        await fs.mkdir(sessionDir, { recursive: true });
        await fs.writeFile(path.join(sessionDir, "workspace.yaml"), "id: test\n");

        token = "token-two";
        await manager.getOrCreate("auth-rebind-session", config, { turnIndex: 1 });

        assert.equal(client.sessions[0].disconnected, true);
        assert.equal(client.configs.length, 2);
        assert.equal(
            client.configs[1].mcpServers.local.env.TEST_ACCESS_TOKEN,
            "token-two",
        );
    } finally {
        if (originalSpecs === undefined) {
            delete process.env.CALLER_AUTH_ENV_TOKENS;
        } else {
            process.env.CALLER_AUTH_ENV_TOKENS = originalSpecs;
        }
        if (originalMode === undefined) {
            delete process.env.CALLER_AUTH_MODE;
        } else {
            process.env.CALLER_AUTH_MODE = originalMode;
        }
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("cluster sessions do not invoke injected delegated-token providers", async () => {
    const originalSpecs = process.env.CALLER_AUTH_ENV_TOKENS;
    const originalMode = process.env.CALLER_AUTH_MODE;
    const originalToken = process.env.TEST_ACCESS_TOKEN;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pilotswarm-cluster-auth-"));
    let providerCalls = 0;
    try {
        process.env.CALLER_AUTH_ENV_TOKENS = "TEST_ACCESS_TOKEN=api://test";
        delete process.env.CALLER_AUTH_MODE;
        delete process.env.TEST_ACCESS_TOKEN;
        const manager = new SessionManager(undefined, null, {
            baseMcpServers: {
                local: { command: "node", args: ["server.js"] },
                remote: { type: "http", url: "https://example.test/mcp" },
            },
            callerTokenProvider: async () => {
                providerCalls += 1;
                return "must-not-be-used";
            },
        }, stateDir);
        const client = new FakeCopilotClient();
        manager.client = client;
        manager.setFactStore(factStore);
        manager.setSessionCatalog(catalog);

        await manager.getOrCreate("cluster-auth-session", { toolNames: [] }, {
            turnIndex: 0,
        });

        assert.equal(providerCalls, 0);
        assert.equal(
            client.configs[0].mcpServers.local.env?.TEST_ACCESS_TOKEN,
            undefined,
        );
        assert.equal(
            client.configs[0].mcpServers.remote.headers?.Authorization,
            undefined,
        );
        assert.equal(process.env.TEST_ACCESS_TOKEN, undefined);
    } finally {
        if (originalSpecs === undefined) {
            delete process.env.CALLER_AUTH_ENV_TOKENS;
        } else {
            process.env.CALLER_AUTH_ENV_TOKENS = originalSpecs;
        }
        if (originalMode === undefined) {
            delete process.env.CALLER_AUTH_MODE;
        } else {
            process.env.CALLER_AUTH_MODE = originalMode;
        }
        if (originalToken === undefined) {
            delete process.env.TEST_ACCESS_TOKEN;
        } else {
            process.env.TEST_ACCESS_TOKEN = originalToken;
        }
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});
