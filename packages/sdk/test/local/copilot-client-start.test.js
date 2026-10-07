/**
 * One start per pooled Copilot client.
 *
 * The SessionManager keeps one CopilotClient per token, transport and
 * workspace root, and hands it out before it is started. The Copilot SDK
 * starts a client on its first createSession/resumeSession, but its
 * `start()` returns early only once the client is connected. Concurrent
 * first calls each spawned a CLI process: every session ended up on the last
 * one, the others kept running after `client.stop()`, and every event and
 * tool call reached a session once per process.
 *
 * The fake client below copies the SDK's start rules, so these tests fail
 * when session creation or resumption skips the shared start.
 *
 * Run: npx vitest run test/local/copilot-client-start.test.js
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
import { createTempSessionLayout } from "../helpers/temp-session-layout.js";

const fakes = vi.hoisted(() => {
    class FakeCopilotSession {
        constructor(connection) {
            this.connection = connection;
        }
    }

    /** Follows the SDK: one CLI process per start, auto-start when not connected. */
    class FakeCopilotClient {
        startCalls = 0;
        processes = 0;
        connection = null;
        state = "disconnected";
        created = [];
        resumed = [];

        constructor() {
            this.failStart = fakes.failNextStart;
            fakes.failNextStart = false;
            fakes.clients.push(this);
        }

        async start() {
            if (this.state === "connected") return;
            this.startCalls += 1;
            this.state = "connecting";
            this.processes += 1;
            await fakes.startGate;
            if (this.failStart) {
                this.failStart = false;
                this.state = "error";
                throw new Error("Copilot CLI failed to start");
            }
            this.connection = { process: this.processes };
            this.state = "connected";
        }

        async createSession(config) {
            if (!this.connection) await this.start();
            this.created.push(config);
            return new FakeCopilotSession(this.connection);
        }

        async resumeSession(sessionId) {
            if (!this.connection) await this.start();
            this.resumed.push(sessionId);
            return new FakeCopilotSession(this.connection);
        }

        async deleteSession() {
            if (!this.connection) throw new Error("Client not connected");
        }

        async stop() {
            this.connection = null;
            this.state = "disconnected";
            return [];
        }

        async forceStop() {
            this.connection = null;
            this.state = "disconnected";
        }

        /** The CLI process exited. */
        exit() {
            this.connection = null;
            this.state = "disconnected";
        }
    }

    return { FakeCopilotClient, clients: [], failNextStart: false, startGate: undefined };
});

vi.mock("../../src/copilot-client.js", async (importOriginal) => ({
    ...(await importOriginal()),
    createCopilotClient: () => new fakes.FakeCopilotClient(),
}));

function createNoopFactStore() {
    return {
        async initialize() {},
        async storeFact(input) {
            return { key: input.key, shared: input.shared === true, stored: true };
        },
        async readFacts() {
            return { count: 0, facts: [] };
        },
        async deleteFact(input) {
            return { key: input.key, shared: input.shared === true, deleted: true };
        },
        async deleteSessionFactsForSession() {
            return 0;
        },
        async close() {},
    };
}

function createHarness() {
    const layout = createTempSessionLayout("pilotswarm-client-start-");
    const manager = new SessionManager(undefined, null, {}, layout.sessionStateDir);
    manager.setFactStore(createNoopFactStore());
    return { manager, layout };
}

/** Hold every start until release() is called. */
function holdStarts() {
    let release;
    fakes.startGate = new Promise((resolve) => { release = resolve; });
    return () => release();
}

/** Let every pending getOrCreate run until it blocks on a start. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const sessionIds = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

describe("SessionManager: one start per Copilot client", () => {
    afterEach(() => {
        fakes.clients.length = 0;
        fakes.failNextStart = false;
        fakes.startGate = undefined;
    });

    it("concurrent first creates start the client once", async () => {
        const { manager, layout } = createHarness();
        const release = holdStarts();
        try {
            const ids = sessionIds("create", 5);
            const pending = ids.map((id) => manager.getOrCreate(id, { toolNames: [] }, { turnIndex: 0 }));
            await settle();
            release();
            await Promise.all(pending);

            expect(fakes.clients).toHaveLength(1);
            const [client] = fakes.clients;
            expect(client.startCalls).toBe(1);
            expect(client.processes).toBe(1);
            expect(client.created).toHaveLength(ids.length);
            const connections = new Set(ids.map((id) => manager.sessions.get(id).getCopilotSession().connection));
            expect(connections.size).toBe(1);
        } finally {
            await manager.shutdown();
            layout.cleanup();
        }
    });

    it("concurrent first resumes start the client once", async () => {
        const { manager, layout } = createHarness();
        const ids = sessionIds("resume", 5);
        for (const id of ids) fs.mkdirSync(path.join(layout.sessionStateDir, id), { recursive: true });
        const release = holdStarts();
        try {
            const pending = ids.map((id) => manager.getOrCreate(id, { toolNames: [] }, { turnIndex: 1 }));
            await settle();
            release();
            await Promise.all(pending);

            expect(fakes.clients).toHaveLength(1);
            expect(fakes.clients[0].startCalls).toBe(1);
            expect(fakes.clients[0].processes).toBe(1);
            expect(fakes.clients[0].resumed.sort()).toEqual([...ids].sort());
        } finally {
            await manager.shutdown();
            layout.cleanup();
        }
    });

    it("a failed start fails every waiting caller, and the next call starts a fresh client", async () => {
        const { manager, layout } = createHarness();
        fakes.failNextStart = true;
        const release = holdStarts();
        try {
            const pending = sessionIds("failed", 3).map((id) =>
                manager.getOrCreate(id, { toolNames: [] }, { turnIndex: 0 }).then(
                    () => null,
                    (error) => error,
                ));
            await settle();
            release();
            const errors = await Promise.all(pending);

            expect(errors.map((error) => error?.message)).toEqual(Array(3).fill("Copilot CLI failed to start"));
            expect(fakes.clients).toHaveLength(1);
            expect(fakes.clients[0].startCalls).toBe(1);
            expect(manager.clients.size).toBe(0);

            await manager.getOrCreate("after-failure", { toolNames: [] }, { turnIndex: 0 });
            expect(fakes.clients).toHaveLength(2);
            expect(fakes.clients[1].startCalls).toBe(1);
            expect(fakes.clients[1].created).toHaveLength(1);
            expect(manager.clients.size).toBe(1);
        } finally {
            await manager.shutdown();
            layout.cleanup();
        }
    });

    it("a restart after the CLI exited also runs once", async () => {
        const { manager, layout } = createHarness();
        try {
            await manager.getOrCreate("before-exit", { toolNames: [] }, { turnIndex: 0 });
            const [client] = fakes.clients;
            expect(client.startCalls).toBe(1);

            client.exit();
            const release = holdStarts();
            const pending = sessionIds("after-exit", 4).map((id) => manager.getOrCreate(id, { toolNames: [] }, { turnIndex: 0 }));
            await settle();
            release();
            await Promise.all(pending);

            expect(fakes.clients).toHaveLength(1);
            expect(client.startCalls).toBe(2);
            expect(client.processes).toBe(2);
        } finally {
            await manager.shutdown();
            layout.cleanup();
        }
    });

    it("shutdown drops a start in progress; the next session gets a new client", async () => {
        const { manager, layout } = createHarness();
        try {
            // This start never finishes.
            holdStarts();
            manager.getOrCreate("stranded", { toolNames: [] }, { turnIndex: 0 }).catch(() => {});
            await settle();
            expect(fakes.clients).toHaveLength(1);
            expect(fakes.clients[0].startCalls).toBe(1);

            await manager.shutdown();
            expect(manager.clients.size).toBe(0);

            fakes.startGate = undefined;
            await manager.getOrCreate("after-shutdown", { toolNames: [] }, { turnIndex: 0 });
            expect(fakes.clients).toHaveLength(2);
            expect(fakes.clients[1].startCalls).toBe(1);
            expect(fakes.clients[1].created).toHaveLength(1);
        } finally {
            await manager.shutdown();
            layout.cleanup();
        }
    });
});
