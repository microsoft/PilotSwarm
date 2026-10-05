import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { EventEmitter } from "node:events";
import { createLivePlane } from "../api/live-plane.js";
import { buildListenConnection } from "../server.js";
import { _setPgAadCredentialForTests, buildSessionCatalogPgClientConfig } from "../../../sdk/dist/pg-pool-factory.js";

const DB = process.env.DATABASE_URL || "";
const CHANNEL = "pilotswarm_live_relay_test";
const RECONNECT_CHANNEL = "pilotswarm_live_reconnect_test";

/** Stub pg clients that record their options. Like pg, connect() calls a password callback. */
function stubClients({ connectError = null } = {}) {
    const clients = [];
    const passwords = [];
    const createClient = (options) => {
        const client = new EventEmitter();
        client.options = options;
        client.connect = async () => {
            if (typeof options.password === "function") passwords.push(await options.password());
            if (connectError) throw connectError;
        };
        client.query = async () => {};
        client.end = async () => {};
        clients.push(client);
        return client;
    };
    return { clients, passwords, createClient };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("relay fans out by session and topic, filters schema, and resolves pointers", { skip: !DB && "DATABASE_URL not set" }, async () => {
    const reads = [];
    const updatedAt = "2026-09-04T00:00:00.000Z";
    const plane = createLivePlane({
        connectionString: DB,
        schema: "live_relay_schema",
        channel: CHANNEL,
        getLive: async (sessionId, topics) => {
            reads.push([sessionId, topics]);
            return [{ topic: topics[0], seq: 8, payload: { whole: true }, updatedBy: "test", updatedAt }];
        },
    });
    await plane.start();
    await plane.start();
    const sender = new pg.Client({ connectionString: DB });
    await sender.connect();
    try {
        const turn = [];
        const presence = [];
        const other = [];
        const off = plane.subscribe("s1", ["turn"], (update) => turn.push(update));
        plane.subscribe("s1", ["presence"], (update) => presence.push(update));
        plane.subscribe("s2", ["turn"], (update) => other.push(update));
        await new Promise((resolve) => setTimeout(resolve, 150));
        const { rows: listeners } = await sender.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE pid <> pg_backend_pid()
                AND datname = current_database()
                AND query = $1`,
            [`LISTEN ${CHANNEL}`],
        );
        assert.equal(listeners[0].n, 1, "start and subscriptions share exactly one LISTEN connection");
        const notify = (payload) => sender.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(payload)]);
        await notify({ schema: "live_relay_schema", sessionId: "s1", topic: "turn", seq: 1, kind: "patch", data: { text: "a" } });
        await notify({ schema: "live_relay_schema", sessionId: "s1", topic: "presence", seq: 2, kind: "signal" });
        await notify({ schema: "wrong_schema", sessionId: "s1", topic: "turn", seq: 3, kind: "patch", data: { ignored: true } });
        await notify({ schema: "live_relay_schema", sessionId: "s2", topic: "presence", seq: 4, kind: "signal" });
        await notify({ schema: "live_relay_schema", sessionId: "s1", topic: "turn", seq: 8, kind: "patch" });

        const deadline = Date.now() + 5_000;
        while ((turn.length < 2 || presence.length < 1) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.deepEqual(turn, [
            { sessionId: "s1", topic: "turn", seq: 1, kind: "patch", data: { text: "a" } },
            { sessionId: "s1", topic: "turn", seq: 8, kind: "snapshot", data: { whole: true }, updatedAt },
        ]);
        assert.deepEqual(presence, [{ sessionId: "s1", topic: "presence", seq: 2, kind: "signal" }]);
        assert.deepEqual(other, []);
        assert.deepEqual(reads, [["s1", ["turn"]]]);

        off();
        await notify({ schema: "live_relay_schema", sessionId: "s1", topic: "turn", seq: 9, kind: "signal" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(turn.length, 2, "unsubscribe removes the exact (session, topic) handler");
    } finally {
        await sender.end();
        await plane.stop();
    }
});

test("without a connection string the live relay degrades to an inert plane", async () => {
    const plane = createLivePlane({ connectionString: "" });
    assert.equal(plane.available, false);
    await plane.start();
    plane.subscribe("s1", ["turn"], () => { throw new Error("must stay inert"); })();
    await plane.stop();
});

test("relay reconnects after its LISTEN backend is terminated", { skip: !DB && "DATABASE_URL not set" }, async () => {
    const plane = createLivePlane({
        connectionString: DB,
        schema: "live_relay_schema",
        channel: RECONNECT_CHANNEL,
    });
    const sender = new pg.Client({ connectionString: DB });
    await sender.connect();
    await plane.start();
    const seen = [];
    plane.subscribe("s-reconnect", ["turn"], (update) => seen.push(update));
    try {
        const { rows } = await sender.query(
            `SELECT pid FROM pg_stat_activity
              WHERE pid <> pg_backend_pid()
                AND datname = current_database()
                AND query = $1
              ORDER BY backend_start DESC
              LIMIT 1`,
            [`LISTEN ${RECONNECT_CHANNEL}`],
        );
        assert.ok(rows[0]?.pid, "the relay owns one discoverable LISTEN backend");
        await sender.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);

        const deadline = Date.now() + 6_000;
        let attempt = 0;
        while (!seen.some((update) => update.data?.recovered) && Date.now() < deadline) {
            attempt += 1;
            await new Promise((resolve) => setTimeout(resolve, 250));
            await sender.query("SELECT pg_notify($1, $2)", [RECONNECT_CHANNEL, JSON.stringify({
                schema: "live_relay_schema",
                sessionId: "s-reconnect",
                topic: "turn",
                seq: attempt,
                kind: "snapshot",
                data: { recovered: true },
            })]);
        }
        assert.equal(seen.at(-1)?.data?.recovered, true);
    } finally {
        await sender.end();
        await plane.stop();
    }
});

test("reconnect refreshes a missed idle without waiting for another notification", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const clients = [];
    const seen = [];
    const plane = createLivePlane({
        connectionString: "test", schema: "test",
        createClient: () => {
            const client = new EventEmitter();
            client.connect = async () => {};
            client.query = async () => {};
            client.end = async () => {};
            clients.push(client);
            return client;
        },
        getLive: async () => [{ topic: "turn", seq: 1, payload: { phase: "idle" } }],
    });
    await plane.start();
    plane.subscribe("s1", ["turn"], (update) => seen.push(update));
    clients[0].emit("notification", { payload: JSON.stringify({ schema: "test", sessionId: "s1", topic: "turn", seq: 99, kind: "snapshot", data: { phase: "live" } }) });
    clients[0].emit("error", new Error("connection lost"));
    t.mock.timers.tick(1000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepEqual(seen.map((update) => [update.kind, update.data?.phase]), [
        ["snapshot", "live"], ["unavailable", undefined], ["snapshot", "idle"],
    ]);
    await plane.stop();
});

test("a slow pointer read cannot regress a newer inline snapshot", async () => {
    const client = new EventEmitter();
    client.connect = async () => {};
    client.query = async () => {};
    client.end = async () => {};
    let resolve;
    const seen = [];
    const plane = createLivePlane({ connectionString: "test", schema: "test", createClient: () => client,
        getLive: () => new Promise((r) => { resolve = r; }),
    });
    await plane.start();
    plane.subscribe("s1", ["turn"], (update) => seen.push(update));
    const notify = (seq, data) => client.emit("notification", { payload: JSON.stringify({ schema: "test", sessionId: "s1", topic: "turn", seq, kind: "snapshot", data }) });
    notify(1);
    notify(2, { text: "new" });
    resolve([{ topic: "turn", seq: 1, payload: { text: "old" } }]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen.map((update) => update.data.text), ["new"]);
    await plane.stop();
});

// The LISTEN connection must follow the session catalog (CMS) rules: the
// same database, the sslmode fix, and the managed-identity token.

test("a plain URL gives the LISTEN client exactly the config it had before", async (t) => {
    const url = "postgresql://dev:dev@127.0.0.1:5432/plain_listen_test";
    const stub = stubClients();
    const plane = createLivePlane({
        connection: buildSessionCatalogPgClientConfig({ store: url }, {}),
        schema: "test",
        createClient: stub.createClient,
    });
    t.after(() => plane.stop());
    await plane.start();
    assert.deepEqual(stub.clients.map((client) => client.options), [
        { connectionString: url, keepAlive: true, connectionTimeoutMillis: 5_000, query_timeout: 5_000 },
    ]);
});

test("sslmode=require reaches the LISTEN client as the CMS sees it", async (t) => {
    const stub = stubClients();
    const plane = createLivePlane({
        connection: buildSessionCatalogPgClientConfig({ store: "postgresql://u:p@db.example.test:5432/cms?sslmode=require" }, {}),
        schema: "test",
        createClient: stub.createClient,
    });
    t.after(() => plane.stop());
    await plane.start();
    assert.equal(stub.clients.length, 1);
    const { options } = stub.clients[0];
    assert.equal(options.connectionString, "postgresql://u:p@db.example.test:5432/cms");
    assert.doesNotMatch(options.connectionString, /sslmode/);
    assert.equal(options.ssl?.rejectUnauthorized, false);
    assert.equal(options.keepAlive, true);
});

test("managed identity: the LISTEN client asks for a fresh token on each reconnect", async (t) => {
    let tokens = 0;
    _setPgAadCredentialForTests({
        getToken: async () => ({ token: `token-${++tokens}`, expiresOnTimestamp: Date.now() + 3_600_000 }),
    });
    t.after(() => _setPgAadCredentialForTests(null));
    const connection = buildSessionCatalogPgClientConfig({
        store: "postgresql://admin:secret@db.example.test:5432/cms?sslmode=require",
        useManagedIdentity: true,
        aadDbUser: "portal-uami",
    }, {});
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const stub = stubClients();
    const plane = createLivePlane({ connection, schema: "test", createClient: stub.createClient });
    t.after(() => plane.stop());
    await plane.start();

    const { options } = stub.clients[0];
    assert.equal(options.user, "portal-uami");
    assert.equal(typeof options.password, "function");
    assert.equal(options.connectionString, undefined, "no URL password can shadow the token callback");
    assert.equal(options.host, "db.example.test");
    assert.equal(options.database, "cms");
    assert.equal(options.ssl?.rejectUnauthorized, false);

    stub.clients[0].emit("error", new Error("connection lost"));
    t.mock.timers.tick(1_000);
    await settle();
    assert.equal(stub.clients.length, 2, "the plane reconnected once");
    assert.deepEqual(stub.passwords, ["token-1", "token-2"], "the reconnect asked the credential again");
});

test("a failed LISTEN connect logs one line with only the error code", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const failure = Object.assign(new Error("password authentication failed for user \"secret-user\" token=abc123"), { code: "28P01" });
    const stub = stubClients({ connectError: failure });
    const plane = createLivePlane({
        connection: { connectionString: "postgresql://secret-user:hunter2@db.example.test/cms" },
        schema: "test",
        createClient: stub.createClient,
    });
    t.after(() => plane.stop());
    await plane.start();
    assert.equal(warn.mock.callCount(), 1);
    const line = warn.mock.calls[0].arguments.join(" ");
    assert.match(line, /28P01/);
    assert.doesNotMatch(line, /secret-user|hunter2|abc123|db\.example\.test|\n/);
});

test("connection: null keeps the plane unavailable even when DATABASE_URL is set", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://u:p@db.example.test:5432/ignored";
    try {
        const plane = createLivePlane({ connection: null });
        assert.equal(plane.available, false);
        await plane.start();
        await plane.stop();
    } finally {
        if (saved === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = saved;
    }
});

test("the portal builds one listener config from the runtime's storage settings", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const connection = buildListenConnection({
        store: "postgresql://u:p@runtime.example.test:5432/runtime?sslmode=require",
        useManagedIdentity: false,
        cmsFactsDatabaseUrl: "postgresql://u:p@cms.example.test:5432/cms?sslmode=require",
    }, {});
    assert.deepEqual(connection, {
        connectionString: "postgresql://u:p@cms.example.test:5432/cms",
        ssl: { rejectUnauthorized: false },
    });
    assert.equal(warn.mock.callCount(), 0);

    // A config that cannot be built leaves the relays off; it never throws.
    assert.equal(buildListenConnection({ store: "sqlite::memory:" }, {}), null);
    assert.equal(buildListenConnection({ store: "postgresql://db.example.test/cms", useManagedIdentity: true }, {}), null);
    assert.equal(warn.mock.callCount(), 2);
});
