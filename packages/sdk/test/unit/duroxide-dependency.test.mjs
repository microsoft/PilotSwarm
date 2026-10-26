import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../../../../package-lock.json", import.meta.url), "utf8"));
const version = "0.2.3";
const assetUrl = name => `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
const platforms = {
    "duroxide-darwin-arm64": { os: "darwin", cpu: "arm64" },
    "duroxide-darwin-x64": { os: "darwin", cpu: "x64" },
    "duroxide-linux-arm64-gnu": { os: "linux", cpu: "arm64", libc: "glibc" },
    "duroxide-linux-x64-gnu": { os: "linux", cpu: "x64", libc: "glibc" },
    "duroxide-windows-x64": { os: "win32", cpu: "x64" },
};
const nativeHashes = {
    "duroxide-darwin-arm64": "d0037c0b7e5fe9280869720b17fd8c4e75aef3b2f4d42d21bf10e26b5bff23e1",
    "duroxide-darwin-x64": "2ced3f00d4a737b2a7030ef9b8540f187d3273b6f80b1fd8232e434cd0814981",
    "duroxide-linux-arm64-gnu": "3dfc2e4e093560ec715b466451fab06327de1619a72deffe821b4e328c221819",
    "duroxide-linux-x64-gnu": "deb046bc6e7325a8ff37f4a117587d72a03886c3bb931a0bec2d96341c1652a0",
    "duroxide-windows-x64": "79ee52bdd95b13c02aa33179f76d834820edbb0809ea30e443ba3743079a21be",
};

test("duroxide and every native platform pin the same official npm release", () => {
    assert.equal(manifest.dependencies.duroxide, version);
    const optionalVersions = Object.fromEntries(Object.keys(platforms).map(name => [name, version]));
    assert.deepEqual(manifest.optionalDependencies, optionalVersions);
    assert.deepEqual(lock.packages["packages/sdk"].dependencies, manifest.dependencies);
    assert.deepEqual(lock.packages["packages/sdk"].optionalDependencies, optionalVersions);
    assert.deepEqual(lock.packages["node_modules/duroxide"].optionalDependencies, optionalVersions);

    const names = ["duroxide", ...Object.keys(platforms)];
    for (const name of names) {
        const entry = lock.packages[`node_modules/${name}`];
        assert.equal(entry.version, version, name);
        assert.equal(entry.resolved, assetUrl(name), name);
        assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, name);
        if (name === "duroxide") continue;
        assert.equal(entry.optional, true, name);
        assert.deepEqual(entry.os, [platforms[name].os], name);
        assert.deepEqual(entry.cpu, [platforms[name].cpu], name);
        assert.deepEqual(entry.libc, platforms[name].libc ? [platforms[name].libc] : undefined, name);
    }

    const lockedDuroxide = Object.keys(lock.packages).filter(name => /(?:^|\/)node_modules\/duroxide(?:-[^/]+)?$/.test(name));
    assert.deepEqual(lockedDuroxide.sort(), names.map(name => `node_modules/${name}`).sort());
});

test("the installed wrapper loads the matching native runtime and provider APIs", () => {
    assert.equal(require("duroxide/package.json").version, version);
    const nativePackage = Object.keys(platforms).find(name =>
        platforms[name].os === process.platform && platforms[name].cpu === process.arch);
    assert.ok(nativePackage, `supported native platform: ${process.platform}/${process.arch}`);
    assert.equal(require(`${nativePackage}/package.json`).version, version);
    const binaryHash = createHash("sha256").update(readFileSync(require.resolve(nativePackage))).digest("hex");
    assert.equal(binaryHash, nativeHashes[nativePackage], `${nativePackage}: expected the official npm binary, not a same-version GitHub build`);

    const { Runtime, Client, OrchestrationContext, SqliteProvider, PostgresProvider } = require("duroxide");
    for (const api of [Runtime, Client, OrchestrationContext, SqliteProvider, PostgresProvider]) {
        assert.equal(typeof api, "function");
    }
    assert.equal(typeof SqliteProvider.inMemory, "function");
    assert.equal(typeof PostgresProvider.connectWithSchema, "function");
    assert.equal(typeof PostgresProvider.connectWithSchemaAndEntra, "function");
});

test("the installed native runtime executes activities and preserves results across restart", { timeout: 30_000 }, async () => {
    const { Runtime, Client, SqliteProvider } = require("duroxide");
    const provider = await SqliteProvider.inMemory();
    const client = new Client(provider);
    let activityCalls = 0;

    for (const phase of ["initial", "restart"]) {
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
        runtime.registerActivity("Echo", async (_ctx, input) => {
            activityCalls++;
            return input;
        });
        runtime.registerOrchestration("NativeCompatibility", function* (ctx, input) {
            return yield ctx.scheduleActivity("Echo", input);
        });
        await runtime.start();
        try {
            if (phase === "restart") {
                const previous = await client.waitForOrchestration("initial", 10_000);
                assert.equal(previous.status, "Completed");
                assert.equal(previous.output, "initial");
                assert.equal(activityCalls, 1);
            }
            await client.startOrchestration(phase, "NativeCompatibility", phase);
            const result = await client.waitForOrchestration(phase, 10_000);
            assert.equal(result.status, "Completed");
            assert.equal(result.output, phase);
        } finally {
            await runtime.shutdown(1000);
        }
    }
    assert.equal(activityCalls, 2);
});
