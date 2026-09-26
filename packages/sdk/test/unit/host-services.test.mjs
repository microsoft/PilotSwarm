import test from "node:test";
import assert from "node:assert/strict";
import {
    PgSessionCatalog, PilotSwarmWorker, PilotSwarmManagementClient,
    WebPilotSwarmManagementClient, createManagementClient, HostServicesError,
} from "../../dist/index.js";
import { getOperation } from "../../api/index.js";
import { loadProviderTypes } from "../../dist/provider-catalog.js";
import { createHostServices } from "../../dist/host-services.js";

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture({ initialized = true, query, connect } = {}) {
    const calls = [], released = [], clients = [];
    let ends = 0;
    const pool = {
        async connect() {
            if (connect) return connect();
            const client = {
                async query(...args) {
                    calls.push(args);
                    return query ? query(...args) : { rows: [{ value: 7 }], rowCount: 1, _types: "private-driver-field" };
                },
                release(...args) { released.push({ client, args }); },
                password: "must-not-be-exposed",
            };
            clients.push(client);
            return client;
        },
        async end() { ends++; },
    };
    // The real owning implementation, with an inert pool: no DB initialization,
    // network, source data or model execution is involved in these unit tests.
    const catalog = new PgSessionCatalog(pool, "fixture_cms");
    catalog.initialized = initialized;
    return { catalog, pool, calls, released, clients, get ends() { return ends; } };
}

test("borrows only an initialized pool, supplies its resolved schema and releases once", async () => {
    const f = fixture();
    let borrowed;
    const result = await f.catalog.withCmsConnection(async (connection, schema) => {
        borrowed = connection;
        assert.equal(schema, "fixture_cms");
        assert.equal(Object.isFrozen(connection), true);
        assert.deepEqual(Reflect.ownKeys(connection), ["query"]);
        for (const key of ["pool", "client", "end", "release", "connect", "password", "connectionString"]) assert.equal(connection[key], undefined);
        const query = connection.query;
        assert.deepEqual(await query("SELECT $1 AS value", [7]), { rows: [{ value: 7 }], rowCount: 1 });
        return "callback-result";
    });
    assert.equal(result, "callback-result");
    assert.deepEqual(f.calls, [["SELECT $1 AS value", [7]]]);
    assert.equal(f.released.length, 1);
    assert.deepEqual(f.released[0].args, [undefined]);
    assert.equal(f.ends, 0);
    await assert.rejects(borrowed.query("SELECT 1"), { code: "CMS_CONNECTION_RELEASED" });
    assert.equal(f.calls.length, 1, "retaining the facade does not retain database access");
    assert.equal(await f.catalog.withCmsConnection((_connection, schema) => schema), "fixture_cms");
});

test("uninitialized, closed and malformed callback paths acquire no connection", async () => {
    const f = fixture({ initialized: false });
    await assert.rejects(f.catalog.withCmsConnection(async () => {}), { code: "CMS_NOT_INITIALIZED" });
    assert.equal(f.clients.length, 0);
    f.catalog.initialized = true;
    await assert.rejects(f.catalog.withCmsConnection(null), TypeError);
    assert.equal(f.clients.length, 0);
    await f.catalog.close();
    assert.equal(f.ends, 1);
    await assert.rejects(f.catalog.withCmsConnection(async () => {}), { code: "CMS_NOT_INITIALIZED" });
    assert.equal(f.clients.length, 0);
});

test("sync/async callback errors and query failures propagate and discard the borrowed client", async () => {
    const failure = new Error("fixture failure");
    for (const callback of [() => { throw failure; }, async () => { throw failure; }]) {
        const f = fixture();
        await assert.rejects(f.catalog.withCmsConnection(callback), err => err === failure);
        assert.equal(f.released.length, 1);
        assert.deepEqual(f.released[0].args, [true]);
        assert.equal(f.ends, 0);
    }
    const f = fixture({ query: () => { throw failure; } });
    await assert.rejects(f.catalog.withCmsConnection(connection => connection.query("SELECT 1")), err => err === failure);
    assert.equal(f.released.length, 1);
    assert.deepEqual(f.released[0].args, [true]);
    assert.equal(f.ends, 0);
});

test("connection acquisition errors do not fabricate a release or replace the pool", async () => {
    const failure = new Error("fixture connect failed");
    const f = fixture({ connect: async () => { throw failure; } });
    await assert.rejects(f.catalog.withCmsConnection(async () => {}), err => err === failure);
    assert.equal(f.released.length, 0);
    assert.equal(f.ends, 0);
});

test("query facade does not accept pg client config, callbacks or submittable objects", async () => {
    for (const args of [[{ submit() {} }], [{ text: "SELECT 1" }], ["SELECT 1", () => {}], ["SELECT 1", {}], [""]]) {
        const f = fixture();
        await assert.rejects(f.catalog.withCmsConnection(connection => connection.query(...args)), { code: "CMS_QUERY_INVALID" });
        assert.equal(f.calls.length, 0);
        assert.equal(f.released.length, 1);
    }
});

test("multi-statement results retain pg's shape but strip all driver metadata", async () => {
    const f = fixture({ query: async () => [
        { rows: [], rowCount: null, command: "BEGIN", _types: "private" },
        { rows: [{ count: 1 }], rowCount: 1, fields: ["private"] },
    ] });
    assert.deepEqual(await f.catalog.withCmsConnection(connection => connection.query("BEGIN; SELECT 1 AS count")), [
        { rows: [], rowCount: null }, { rows: [{ count: 1 }], rowCount: 1 },
    ]);
    assert.equal(f.released.length, 1);
});

test("concurrent borrows use separate clients and release only their own callback's connection", async () => {
    const f = fixture(), first = deferred(), second = deferred(), entered = deferred();
    const one = f.catalog.withCmsConnection(async connection => {
        await connection.query("SELECT 1");
        entered.resolve();
        await first.promise;
    });
    await entered.promise;
    const two = f.catalog.withCmsConnection(async connection => { await connection.query("SELECT 2"); await second.promise; });
    await Promise.resolve();
    assert.equal(f.clients.length, 2);
    assert.equal(f.released.length, 0);
    second.resolve();
    await two;
    assert.equal(f.released[0].client, f.clients[1]);
    first.resolve();
    await one;
    assert.equal(f.released[1].client, f.clients[0]);
    assert.equal(f.ends, 0);
});

test("an unawaited query is drained before release, with its failure still observable", async () => {
    for (const fails of [false, true]) {
        const query = deferred(), entered = deferred();
        const f = fixture({ query: () => query.promise });
        let connection;
        const borrowing = f.catalog.withCmsConnection(async borrowed => {
            connection = borrowed;
            void borrowed.query("SELECT 1");
            entered.resolve();
            return "done";
        });
        await entered.promise;
        await Promise.resolve();
        assert.equal(f.released.length, 0);
        await assert.rejects(connection.query("SELECT 2"), { code: "CMS_CONNECTION_RELEASED" });
        if (fails) {
            const error = new Error("fixture query failed");
            query.reject(error);
            await assert.rejects(borrowing, err => err === error);
        } else {
            query.resolve({ rows: [], rowCount: 0 });
            assert.equal(await borrowing, "done");
        }
        assert.equal(f.released.length, 1);
        assert.deepEqual(f.released[0].args, [fails ? true : undefined]);
    }
});

test("shutdown during acquisition releases the client without running the callback", async () => {
    const acquisition = deferred(), released = [];
    const f = fixture({ connect: () => acquisition.promise });
    let ran = false;
    const borrow = f.catalog.withCmsConnection(async () => { ran = true; });
    await f.catalog.close();
    acquisition.resolve({ release(...args) { released.push(args); } });
    await assert.rejects(borrow, { code: "CMS_NOT_INITIALIZED" });
    assert.equal(ran, false);
    assert.deepEqual(released, [[true]]);
});

for (const [name, prototype] of [
    ["worker", PilotSwarmWorker.prototype], ["direct management client", PilotSwarmManagementClient.prototype],
]) {
    test(`${name} binds its existing catalog only after start and never binds a fake invoker`, async () => {
        const f = fixture();
        const host = Object.assign(Object.create(prototype), {
            _catalog: f.catalog, _started: false,
            start() { throw new Error("must not start a second host"); },
        });
        assert.throws(() => host.getHostServices(), { code: "HOST_NOT_STARTED" });
        host._started = true;
        const services = host.getHostServices();
        assert.equal(Object.isFrozen(services), true);
        assert.deepEqual(Object.keys(services), ["withCmsConnection"]);
        assert.equal(services.runEphemeralSession, undefined);
        assert.equal(await services.withCmsConnection((_db, schema) => schema), "fixture_cms");
        assert.equal(f.released.length, 1);
        assert.equal(f.ends, 0);
        host._started = false;
        await assert.rejects(services.withCmsConnection(async () => {}), { code: "HOST_SERVICES_EXPIRED" });
        host._started = true;
        host._catalog = fixture().catalog;
        await assert.rejects(services.withCmsConnection(async () => {}), { code: "HOST_SERVICES_EXPIRED" });
        assert.equal(await host.getHostServices().withCmsConnection((_db, schema) => schema), "fixture_cms");
        host._catalog = null;
        assert.throws(() => host.getHostServices(), { code: "CMS_UNSUPPORTED" });
        host._catalog = {};
        assert.throws(() => host.getHostServices(), { code: "CMS_UNSUPPORTED" });
    });
}

test("both Web constructors explicitly refuse host services without an HTTP call", () => {
    let calls = 0;
    const options = { apiUrl: "https://portal.example.invalid", fetchImpl() { calls++; throw new Error("no HTTP expected"); } };
    for (const client of [new PilotSwarmManagementClient(options), new WebPilotSwarmManagementClient(options), createManagementClient(options)]) {
        assert.throws(() => client.getHostServices(), { code: "WEB_MODE_UNSUPPORTED" });
    }
    assert.equal(calls, 0);
    for (const operation of ["getHostServices", "withCmsConnection", "runEphemeralSession", "invokeNoTools", "describeNoToolsModel"]) {
        assert.equal(getOperation(operation), null);
    }
    assert.ok(new HostServicesError("CMS_UNSUPPORTED") instanceof Error);
});

for (const [name, prototype, field] of [
    ["worker", PilotSwarmWorker.prototype, "_modelProviderTypes"],
    ["direct management", PilotSwarmManagementClient.prototype, "_modelProviders"],
]) {
    test(`${name} rejects anonymous execution before credential access`, async () => {
        const f = fixture();
        const actor = { provider: "none", subject: "unknown" };
        const reads = [];
        f.catalog.providers.lookupUserId = async (...args) => {
            reads.push(args);
            return 1;
        };
        const host = Object.assign(Object.create(prototype), {
            _catalog: f.catalog, _started: true,
            [field]: loadProviderTypes({ providers: [{ id: "synthetic", type: "github", models: ["model"] }] }),
        });
        const bound = host.getHostServices();
        assert.throws(() => host.getHostServices({ actor }), /does not accept options/);
        assert.deepEqual(Object.keys(bound).sort(), ["runEphemeralSession", "withCmsConnection"]);
        assert.equal(reads.length, 0);
        const selection = { actor, model: "mine:model" };
        await assert.rejects(bound.runEphemeralSession(selection), { code: "EPHEMERAL_INVALID_REQUEST" });
        assert.deepEqual(reads, [], "working-directory and callback validation precede credential access");
        assert.equal(reads.length, 0);
        host._started = false;
        await assert.rejects(bound.runEphemeralSession(selection), { code: "HOST_SERVICES_EXPIRED" });
        assert.equal(f.clients.length, 0);
    });
}

test("worker binds a real invoker from its type catalog without starting or borrowing another host", async () => {
    const f = fixture();
    const types = loadProviderTypes({ providers: [{ id: "synthetic", type: "github", models: ["model"] }] });
    const host = Object.assign(Object.create(PilotSwarmWorker.prototype), {
        _catalog: f.catalog, _started: true, _modelProviderTypes: types,
        _modelProviders: null, // A worker-wide runtime registry is not an authorization input.
    });
    const services = host.getHostServices();
    assert.equal(typeof services.runEphemeralSession, "function");
    assert.equal(services.invokeNoTools, undefined);
    assert.equal(services.describeNoToolsModel, undefined);
    assert.equal(f.clients.length, 0);
    await assert.rejects(services.runEphemeralSession({}), { code: "EPHEMERAL_INVALID_REQUEST" });
    host._started = false;
    await assert.rejects(services.runEphemeralSession({}), { code: "HOST_SERVICES_EXPIRED" });
    host._started = true;
    host._catalog = fixture().catalog;
    await assert.rejects(services.runEphemeralSession({}), { code: "HOST_SERVICES_EXPIRED" });
    assert.equal(f.clients.length, 0);
    assert.equal(f.ends, 0);
    assert.equal(createHostServices(() => true, () => f.catalog).runEphemeralSession, undefined,
        "CMS-only portal adapter binding never enables model execution");
    assert.equal(createHostServices(() => true, () => f.catalog).describeNoToolsModel, undefined);
});

function lifecycleHarness() {
    const events = [];
    const client = new PilotSwarmManagementClient({ store: "sqlite::memory:" });
    const createResources = () => {
        const catalog = new PgSessionCatalog({
            async connect() {
                events.push("cms.borrow");
                return {
                    async query() { return { rows: [{ value: 1 }], rowCount: 1 }; },
                    release() { events.push("cms.release"); },
                };
            },
            async end() { events.push("cms.close"); },
        }, "fixture_cms");
        catalog.initialized = true;
        client._catalog = catalog;
        client._factStore = { async close() { events.push("facts.close"); } };
        client._graphStore = { async close() { events.push("graph.close"); } };
        client._ephemeralHost.reset();
        client._started = true;
        return catalog;
    };
    return { client, catalog: createResources(), events, createResources };
}

test("management shutdown drains ephemeral work and joins reentrant stop before closing stores", async () => {
    const h = lifecycleHarness(), active = deferred(), aborted = deferred();
    let reentrantStop;
    h.client._ephemeralHost.track(active.promise);
    h.client._ephemeralHost.signal.addEventListener("abort", () => {
        reentrantStop = h.client.stop();
        aborted.resolve();
    }, { once: true });
    const stopping = h.client.stop();
    try {
        await aborted.promise;
        assert.equal(reentrantStop, stopping);
        assert.deepEqual(h.events, [], "store cleanup waits for already-owned work");
    } finally {
        active.resolve();
        await Promise.all([stopping, reentrantStop]);
    }
    assert.deepEqual(h.events, ["graph.close", "facts.close", "cms.close"]);
    await h.client.stop();
    assert.equal(h.events.length, 3, "repeated stops do not close stores twice");
});

test("management store-close errors do not skip remaining cleanup", async () => {
    const h = lifecycleHarness();
    for (const field of ["_graphStore", "_factStore", "_catalog"]) {
        const close = h.client[field].close.bind(h.client[field]);
        h.client[field].close = async () => {
            await close();
            throw new Error("fixture close failure");
        };
    }
    await h.client.stop();
    assert.deepEqual(h.events, ["graph.close", "facts.close", "cms.close"]);
    assert.equal(h.client._started, false);
    for (const field of ["_graphStore", "_factStore", "_catalog", "_duroxideClient"]) {
        assert.equal(h.client[field], null);
    }
});

test("concurrent management starts wait for shutdown and renew host bindings once", async t => {
    const h = lifecycleHarness(), entered = deferred(), release = deferred();
    const previousServices = h.client.getHostServices();
    const previousSignal = h.client._ephemeralHost.signal;
    const close = h.catalog.close.bind(h.catalog);
    h.catalog.close = async () => {
        entered.resolve();
        await release.promise;
        await close();
    };
    const startup = t.mock.method(h.client, "_start", async () => { h.createResources(); });
    const stopping = h.client.stop(), concurrentStop = h.client.stop();
    let restart;
    try {
        await entered.promise;
        restart = Promise.all([h.client.start(), h.client.start()]);
        assert.equal(startup.mock.callCount(), 0);
        assert.equal(stopping, concurrentStop);
        release.resolve();
        await Promise.all([stopping, restart]);
        assert.equal(startup.mock.callCount(), 1);
        assert.equal(h.client._started, true);
        assert.notEqual(h.client._catalog, h.catalog);
        assert.equal(h.catalog.initialized, false);
        assert.equal(previousSignal.aborted, true);
        assert.equal(h.client._ephemeralHost.signal.aborted, false);
        await assert.rejects(previousServices.withCmsConnection(async () => {}), { code: "HOST_SERVICES_EXPIRED" });
        await h.client.getHostServices().withCmsConnection(async connection => {
            assert.equal((await connection.query("SELECT 1 AS value")).rows[0].value, 1);
        });
        await h.client.start();
        assert.equal(startup.mock.callCount(), 1);
    } finally {
        release.resolve();
        await Promise.all([stopping, restart]);
        await h.client.stop();
    }
    for (const event of ["graph.close", "facts.close", "cms.close"]) {
        assert.equal(h.events.filter(value => value === event).length, 2);
    }
});

for (const startFails of [false, true]) {
    test(`management shutdown waits for ${startFails ? "failed" : "successful"} startup before releasing resources`, async t => {
        const h = lifecycleHarness(), entered = deferred(), release = deferred();
        await h.client.stop();
        h.events.length = 0;
        const error = new Error("fixture startup failure");
        const startup = t.mock.method(h.client, "_start", async () => {
            h.createResources();
            h.client._started = false;
            entered.resolve();
            await release.promise;
            if (startFails) throw error;
            h.client._started = true;
        });
        const started = Promise.allSettled([h.client.start(), h.client.start()]);
        await entered.promise;
        const stopping = h.client.stop(), concurrentStop = h.client.stop();
        try {
            assert.deepEqual(h.events, [], "startup owns its partially initialized resources");
        } finally {
            release.resolve();
            await Promise.all([started, stopping, concurrentStop]);
        }
        for (const result of await started) {
            assert.equal(result.status, startFails ? "rejected" : "fulfilled");
            if (startFails) assert.equal(result.reason, error);
        }
        assert.equal(startup.mock.callCount(), 1);
        assert.equal(stopping, concurrentStop);
        assert.deepEqual(h.events, ["graph.close", "facts.close", "cms.close"]);
        assert.equal(h.client._started, false);
        assert.equal(h.client._catalog, null);
    });
}
