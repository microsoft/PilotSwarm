/**
 * Compute providers and compute targets (docs/proposals/compute-providers.md):
 * the provider registry, the built-in local provider, target name rules,
 * endpoint → SDK connection mapping, and the session config projection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    COMPUTE_ERROR_CODES,
    ComputeProviderRegistry,
    LOCAL_COMPUTE_KIND,
    createLocalComputeProvider,
    isLoopbackAddress,
    runtimeConnectionFor,
    runtimeEndpointKey,
    validateComputeTargetName,
} from "../../dist/compute.js";
import { projectSerializableSessionConfig } from "../../dist/client.js";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";

function fakeProvider(kind, overrides = {}) {
    return {
        kind,
        capabilities: { os: ["linux"], sandboxed: true, files: "provider-api" },
        async bind(req) { return { ok: true, host: { kind, id: `host-${req.rootSessionId}`, incarnation: "1" } }; },
        async connect() { return { ok: true, endpoint: { transport: "uri", address: "10.0.0.5:7777", connectionToken: "t" }, workspace: { cwd: "/work" } }; },
        ...overrides,
    };
}

test("the registry always has the local provider", () => {
    const registry = new ComputeProviderRegistry();
    assert.deepEqual(registry.kinds(), [LOCAL_COMPUTE_KIND]);
    assert.equal(registry.get(LOCAL_COMPUTE_KIND).kind, LOCAL_COMPUTE_KIND);
});

test("the registry adds providers by kind and refuses duplicates and bad kinds", () => {
    const registry = new ComputeProviderRegistry([fakeProvider("sandbox-a")]);
    assert.deepEqual(registry.kinds(), ["local", "sandbox-a"]);
    assert.throws(() => registry.register(fakeProvider("sandbox-a")), /registered twice/);
    registry.register(fakeProvider("sandbox-a"), { replace: true });
    assert.throws(() => registry.register(fakeProvider("Bad Kind")), /kind must match/);
    assert.throws(() => registry.register({ kind: "no-methods", capabilities: {} }), /must implement bind and connect/);
});

test("an application may replace the local provider", () => {
    const custom = fakeProvider(LOCAL_COMPUTE_KIND);
    const registry = new ComputeProviderRegistry([custom]);
    assert.equal(registry.get(LOCAL_COMPUTE_KIND), custom);
});

test("the local provider binds to the worker and connects locally with the same folders", async () => {
    const local = createLocalComputeProvider();
    const bound = await local.bind({ target: null, sessionId: "s", rootSessionId: "r", owner: null, workerNodeId: "worker-1" });
    assert.equal(bound.ok, true);
    assert.equal(bound.host.id, "worker-1");
    const connected = await local.connect({
        target: null, host: bound.host, sessionId: "s", rootSessionId: "r", workerNodeId: "worker-1", turnIndex: 3,
        workspace: { cwd: "/ws/a", additionalDirectories: ["/ws/shared"] },
    });
    assert.deepEqual(connected, { ok: true, endpoint: { transport: "local" }, workspace: { cwd: "/ws/a", additionalDirectories: ["/ws/shared"] } });
    assert.equal(local.capabilities.sandboxed, false);
    assert.deepEqual(local.capabilities.os, [process.platform]);
});

test("a target is named after whoever owns it", () => {
    assert.deepEqual(validateComputeTargetName(" shared/team-sandboxes.1 "), { ok: true, name: "shared/team-sandboxes.1" });
    assert.equal(validateComputeTargetName("alice@example.com/box").ok, true);
    // A bare label is shorthand a caller may use, never a name that is stored.
    for (const bad of ["", "team-sandboxes.1", "-x", "shared/a:b", "shared/has space", "shared/" + "x".repeat(65), "/x", "x/", 7, null]) {
        const checked = validateComputeTargetName(bad);
        assert.equal(checked.ok, false, String(bad));
        assert.equal(checked.code, COMPUTE_ERROR_CODES.INVALID);
    }
});

test("endpoints map to SDK connections and pool keys", () => {
    assert.equal(runtimeConnectionFor(undefined).kind, "stdio");
    assert.equal(runtimeConnectionFor({ transport: "local" }).kind, "stdio");
    const uri = runtimeConnectionFor({ transport: "uri", address: " 10.0.0.5:7777 ", connectionToken: "tok" });
    assert.equal(uri.kind, "uri");
    assert.equal(uri.url, "10.0.0.5:7777");
    assert.equal(uri.connectionToken, "tok");
    assert.throws(() => runtimeConnectionFor({ transport: "uri", address: "" }), /needs an address/);
    assert.throws(() => runtimeConnectionFor({ transport: "carrier-pigeon" }), /unknown compute transport/);
    assert.equal(runtimeEndpointKey({ transport: "local" }), "");
});

test("a pool key changes with the token and the host incarnation, and never holds the token", () => {
    const endpoint = { transport: "uri", address: "127.0.0.1:1", connectionToken: "secret-token" };
    const host = { kind: "k", id: "h", incarnation: "1" };
    const key = runtimeEndpointKey(endpoint, host);
    assert.match(key, /^uri\0[0-9a-f]{32}$/);
    assert.equal(key.includes("secret-token"), false);
    assert.equal(runtimeEndpointKey(endpoint, { ...host }), key);
    assert.notEqual(runtimeEndpointKey({ ...endpoint, connectionToken: "rotated" }, host), key);
    assert.notEqual(runtimeEndpointKey(endpoint, { ...host, incarnation: "2" }), key);
    assert.notEqual(runtimeEndpointKey(endpoint, { ...host, id: "other" }), key);
});

test("only addresses on this machine count as loopback", () => {
    for (const ok of ["127.0.0.1:1", "localhost:9", "[::1]:5", "http://127.0.0.5:80", "ws://localhost:1"]) {
        assert.equal(isLoopbackAddress(ok), true, ok);
    }
    for (const bad of ["10.0.0.5:7777", "example.invalid:1", "http://169.254.169.254", "127.0.0.1.example.invalid:1", "", "::"]) {
        assert.equal(isLoopbackAddress(bad), false, bad);
    }
});

test("the creation config projection keeps computeTarget only when set", () => {
    assert.equal("computeTarget" in projectSerializableSessionConfig({ model: "p:m" }, 30), false);
    assert.equal(projectSerializableSessionConfig({ model: "p:m", computeTarget: "shared/team-sandboxes" }, 30).computeTarget, "shared/team-sandboxes");
});

test("migration 0084 adds compute targets after 0083", () => {
    const migrations = CMS_MIGRATIONS("ps_test");
    const at = migrations.findIndex((m) => m.version === "0084");
    assert.ok(at > 0);
    assert.equal(migrations[at - 1].version, "0083");
    assert.equal(migrations[at].name, "compute_targets");
    const sql = migrations[at].sql;
    for (const fn of [
        "cms_compute_target_create", "cms_compute_target_assert_manage", "cms_compute_target_update",
        "cms_compute_target_delete", "cms_compute_target_list", "cms_compute_target_assert_session",
        "cms_compute_target_resolve_for_session",
    ]) {
        assert.match(sql, new RegExp(`"ps_test"\\.${fn}\\(`), fn);
    }
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "ps_test"\.compute_targets/);
});
