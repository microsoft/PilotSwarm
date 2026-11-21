// The canvas-plane relay against a REAL Postgres LISTEN/NOTIFY round trip:
// schema filtering, per-session fan-out, unsubscribe, and patch passthrough.
//
// Needs DATABASE_URL (the local dev Postgres). Skips cleanly without it so
// the suite stays green in environments with no database.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { EventEmitter } from "node:events";
import { createCanvasPlane } from "../api/canvas-plane.js";
import { _setPgAadCredentialForTests, buildSessionCatalogPgClientConfig } from "../../../sdk/dist/pg-pool-factory.js";

const DB = process.env.DATABASE_URL || "";
const CHANNEL = "pilotswarm_canvas_live_relay_test";

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

test("relay round trip: NOTIFY → subscriber, schema-filtered, patch passthrough", { skip: !DB && "DATABASE_URL not set" }, async () => {
    const plane = createCanvasPlane({ connectionString: DB, schema: "relay_test_schema", channel: CHANNEL });
    assert.equal(plane.available, true);
    await plane.start();

    const sender = new pg.Client({ connectionString: DB });
    await sender.connect();
    try {
        const got = [];
        const gotOther = [];
        const unsubscribe = plane.subscribe("sess-a", (u) => got.push(u));
        plane.subscribe("sess-b", (u) => gotOther.push(u));
        await new Promise((r) => setTimeout(r, 150)); // LISTEN settles

        const send = (payload) => sender.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(payload)]);
        await send({ schema: "relay_test_schema", sessionId: "sess-a", slot: 1, seq: 1, kind: "data", patch: { g: 1 } });
        await send({ schema: "relay_test_schema", sessionId: "sess-a", slot: 1, seq: 2, kind: "doc" });
        await send({ schema: "SOME_OTHER_SCHEMA", sessionId: "sess-a", slot: 1, seq: 3, kind: "data" });
        await send({ schema: "relay_test_schema", sessionId: "sess-unwatched", slot: 1, seq: 1, kind: "data" });

        const deadline = Date.now() + 5_000;
        while (got.length < 2 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(got.length, 2, "own-schema, own-session pings only");
        assert.deepEqual(got[0], { slot: 1, seq: 1, kind: "data", patch: { g: 1 } });
        assert.deepEqual(got[1], { slot: 1, seq: 2, kind: "doc" });
        assert.equal(gotOther.length, 0, "fan-out is per session");

        unsubscribe();
        await send({ schema: "relay_test_schema", sessionId: "sess-a", slot: 1, seq: 4, kind: "data" });
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(got.length, 2, "unsubscribed sockets hear nothing");
    } finally {
        await sender.end();
        await plane.stop();
    }
});

test("without a connection string the plane reports unavailable and subscribe is inert", async () => {
    const plane = createCanvasPlane({ connectionString: "" });
    assert.equal(plane.available, false);
    await plane.start();
    const off = plane.subscribe("s", () => {});
    off();
    await plane.stop();
});

// The LISTEN connection must follow the session catalog (CMS) rules: the
// same database, the sslmode fix, and the managed-identity token.

test("a plain URL gives the LISTEN client exactly the config it had before", async (t) => {
    const url = "postgresql://dev:dev@127.0.0.1:5432/plain_listen_test";
    const stub = stubClients();
    const plane = createCanvasPlane({
        connection: buildSessionCatalogPgClientConfig({ store: url }, {}),
        schema: "test",
        createClient: stub.createClient,
    });
    t.after(() => plane.stop());
    await plane.start();
    assert.deepEqual(stub.clients.map((client) => client.options), [{ connectionString: url, keepAlive: true }]);
});

test("sslmode=require reaches the LISTEN client as the CMS sees it", async (t) => {
    const stub = stubClients();
    const plane = createCanvasPlane({
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
    const plane = createCanvasPlane({ connection, schema: "test", createClient: stub.createClient });
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
    const failure = Object.assign(new Error("self-signed certificate in chain for secret-user:hunter2"), { code: "SELF_SIGNED_CERT_IN_CHAIN" });
    const stub = stubClients({ connectError: failure });
    const plane = createCanvasPlane({
        connection: { connectionString: "postgresql://secret-user:hunter2@db.example.test/cms" },
        schema: "test",
        createClient: stub.createClient,
    });
    t.after(() => plane.stop());
    await plane.start();
    assert.equal(warn.mock.callCount(), 1);
    const line = warn.mock.calls[0].arguments.join(" ");
    assert.match(line, /SELF_SIGNED_CERT_IN_CHAIN/);
    assert.doesNotMatch(line, /secret-user|hunter2|db\.example\.test|\n/);
});

test("connection: null keeps the plane unavailable even when DATABASE_URL is set", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://u:p@db.example.test:5432/ignored";
    try {
        const plane = createCanvasPlane({ connection: null });
        assert.equal(plane.available, false);
        await plane.start();
        await plane.stop();
    } finally {
        if (saved === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = saved;
    }
});

test("a dropped connection (pg fires both error and end) opens one new LISTEN client and closes the old one", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const stub = stubClients();
    let ended = 0;
    const createClient = (options) => {
        const client = stub.createClient(options);
        client.end = async () => { ended += 1; };
        return client;
    };
    const plane = createCanvasPlane({ connection: { connectionString: "postgresql://u@db.example.test/cms" }, schema: "test", createClient });
    t.after(() => plane.stop());
    await plane.start();
    stub.clients[0].emit("error", new Error("connection lost"));
    stub.clients[0].emit("end");
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(stub.clients.length, 2, "one new client, not two");
    assert.equal(ended, 1, "the dropped client is closed once");
});

// A LISTEN connection that stops answering (a network stall, 2026-11-06 06:30Z) left its liveness probe pending, and the
// next tick gave the same client a second query: pg's "Calling client.query() when the client is already executing a
// query" warning. A probe still out at the next tick now drops the connection and opens a new one instead.
test("a liveness probe that does not answer is never followed by a second query on that client: the connection is replaced", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const stub = stubClients();
    const queries = new Map();
    const createClient = (options) => {
        const client = stub.createClient(options);
        const sent = [];
        queries.set(client, sent);
        let ended = 0;
        client.end = async () => { ended += 1; client.ended = ended; };
        // LISTEN answers; SELECT 1 never does on the first client (it stopped answering), and does on later ones.
        client.query = (text) => {
            sent.push(text);
            if (text === "SELECT 1" && stub.clients.indexOf(client) === 0) return new Promise(() => {});
            return Promise.resolve({ rows: [] });
        };
        return client;
    };
    const plane = createCanvasPlane({ connection: { connectionString: "postgres://db.example.test/cms" }, schema: "test", createClient });
    t.after(() => plane.stop());
    await plane.start();
    const [first] = stub.clients;
    assert.deepEqual(queries.get(first), ["LISTEN pilotswarm_canvas_live"]);

    t.mock.timers.tick(30_000);
    await settle();
    assert.deepEqual(queries.get(first), ["LISTEN pilotswarm_canvas_live", "SELECT 1"]);
    // The next tick: the probe is still out. No second query; the connection is dropped and a new one opened.
    t.mock.timers.tick(30_000);
    await settle();
    assert.deepEqual(queries.get(first), ["LISTEN pilotswarm_canvas_live", "SELECT 1"], "no second query on a busy client");
    assert.equal(first.ended, 1, "the stalled connection is closed");
    t.mock.timers.tick(1_000);
    await settle();
    assert.equal(stub.clients.length, 2, "one new LISTEN connection");
    const [, second] = stub.clients;
    assert.deepEqual(queries.get(second), ["LISTEN pilotswarm_canvas_live"]);
    // The new connection answers its probes: one query per tick, and it stays.
    for (let tick = 0; tick < 3; tick++) {
        t.mock.timers.tick(30_000);
        await settle();
    }
    assert.deepEqual(queries.get(second), ["LISTEN pilotswarm_canvas_live", "SELECT 1", "SELECT 1", "SELECT 1"]);
    assert.equal(stub.clients.length, 2);
    assert.equal(second.ended, undefined);
});
