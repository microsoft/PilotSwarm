import test from "node:test";
import assert from "node:assert/strict";
import { createCopilotAgentHarnessClient, createCopilotAgentHarnessClientFrom } from "../../dist/agent-harness.js";
import { ManagedSession } from "../../dist/managed-session.js";
import { SessionManager } from "../../dist/session-manager.js";

class FakeHarnessSession {
    harness = "fake";
    sessionId = "fake-session";
    listeners = new Map();
    catchAll = [];
    registeredTools = [];
    rpc = {
        tasks: {
            async list() { return { tasks: [] }; },
            async cancel() { return { cancelled: true }; },
            async remove() {},
            async getProgress() { return {}; },
        },
    };

    on(eventType, handler) {
        if (typeof eventType === "function") {
            this.catchAll.push(eventType);
            return () => { this.catchAll = this.catchAll.filter(candidate => candidate !== eventType); };
        }
        const handlers = this.listeners.get(eventType) ?? [];
        handlers.push(handler);
        this.listeners.set(eventType, handlers);
        return () => this.listeners.set(eventType, (this.listeners.get(eventType) ?? []).filter(candidate => candidate !== handler));
    }

    emit(type, data = {}) {
        for (const handler of this.catchAll) handler({ type, data });
        for (const handler of this.listeners.get(type) ?? []) handler({ type, data });
    }

    registerTools(tools) { this.registeredTools = tools; }
    async send() {
        const messageId = "fake-message";
        queueMicrotask(() => {
            this.emit("user.message", { messageId });
            this.emit("assistant.message", { content: "fake harness response" });
            this.emit("session.idle", {});
        });
        return messageId;
    }
    abort() {}
    async disconnect() {}
    async getEvents() { return []; }
}

class FakeHarnessClient {
    harness = "fake";
    session = new FakeHarnessSession();
    starts = 0;
    creates = [];
    async start() { this.starts++; }
    async createSession(config) { this.creates.push(config); return this.session; }
    async resumeSession(_sessionId, config) { this.creates.push(config); return this.session; }
    async deleteSession() {}
    async listModels() { return []; }
    async stop() { return []; }
    async forceStop() {}
}

test("SessionManager creates and runs a session through an injected harness factory", async () => {
    const client = new FakeHarnessClient();
    const factoryCalls = [];
    const manager = Reflect.construct(SessionManager, [undefined, null, {}, undefined, (options, context) => {
        factoryCalls.push({ options, context });
        return client;
    }]);
    manager.setFactStore({});

    const session = await manager.getOrCreate("fake-session", {}, { turnIndex: 0 });
    const result = await session.runTurn("hello");

    assert.equal(result.type, "completed");
    assert.equal(result.content, "fake harness response");
    assert.equal(factoryCalls.length, 1);
    assert.equal(factoryCalls[0].options.sessionStateDir, manager.getSessionStateDir());
    assert.equal(client.starts, 1);
    assert.equal(client.creates.length, 1);
    assert.ok(client.session.registeredTools.length > 0);
    await manager.shutdown();
});

test("ManagedSession preserves the raw Copilot session constructor surface", () => {
    const rawSession = new FakeHarnessSession();
    delete rawSession.harness;
    const managed = new ManagedSession("raw-session", rawSession, {});
    assert.equal(managed.getCopilotSession(), rawSession);
});

test("the legacy client seam preserves an omitted start method", async () => {
    const session = new FakeHarnessSession();
    const legacyClient = {
        async createSession() { return session; },
        async resumeSession() { return session; },
        async deleteSession() {},
        async listModels() { return []; },
        async stop() { return []; },
        async forceStop() {},
    };
    const manager = new SessionManager();
    manager.client = legacyClient;
    manager.setFactStore({});

    const managed = await manager.getOrCreate("legacy-no-start", {}, { turnIndex: 0 });
    assert.equal((await managed.runTurn("hello")).content, "fake harness response");
});

test("the default harness factory preserves Copilot stdio transport and maps session storage", () => {
    const client = createCopilotAgentHarnessClient({
        sessionStateDir: "/synthetic/session-state",
        env: { COPILOT_HOME: "/ambient/copilot" },
    });
    assert.equal(client.harness, "copilot");
    assert.equal(client.raw.connectionConfig.kind, "stdio");
    assert.equal(client.raw.requestHandler, null);
    assert.equal(client.raw.resolvedEnv.COPILOT_HOME, "/synthetic");
    assert.equal(Object.hasOwn(client.raw.options, "sessionStateDir"), false);
});

test("the Copilot adapter preserves confirmation, final-message, and settlement event order", async () => {
    const rawSession = new FakeHarnessSession();
    const rawClient = new FakeHarnessClient();
    rawClient.session = rawSession;
    const client = createCopilotAgentHarnessClientFrom(rawClient);
    const session = await client.createSession({});
    const events = [];
    session.on(event => events.push(event));

    const messageId = await session.send({ prompt: "hello" });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(messageId, "fake-message");
    assert.deepEqual(events.map(event => event.type), ["user.message", "assistant.message", "session.idle"]);
    assert.equal(events[0].data.messageId, messageId);
    assert.equal(events[1].data.content, "fake harness response");
});
