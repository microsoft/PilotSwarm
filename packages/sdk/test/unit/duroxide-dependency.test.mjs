import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../../../../package-lock.json", import.meta.url), "utf8"));
const version = "0.2.3";
const assetUrl = name => `https://github.com/microsoft/duroxide-node/releases/download/v${version}/${name}-${version}.tgz`;
const platforms = {
    "duroxide-darwin-arm64": { os: "darwin", cpu: "arm64" },
    "duroxide-darwin-x64": { os: "darwin", cpu: "x64" },
    "duroxide-linux-arm64-gnu": { os: "linux", cpu: "arm64", libc: "glibc" },
    "duroxide-linux-x64-gnu": { os: "linux", cpu: "x64", libc: "glibc" },
    "duroxide-windows-x64": { os: "win32", cpu: "x64" },
};

test("duroxide and every native platform pin the same published security release", () => {
    assert.equal(manifest.dependencies.duroxide, assetUrl("duroxide"));
    const optionalVersions = Object.fromEntries(Object.keys(platforms).map(name => [name, version]));
    const optionalAssets = Object.fromEntries(Object.keys(platforms).map(name => [name, assetUrl(name)]));
    assert.deepEqual(manifest.optionalDependencies, optionalAssets);
    assert.deepEqual(lock.packages["packages/sdk"].dependencies, manifest.dependencies);
    assert.deepEqual(lock.packages["packages/sdk"].optionalDependencies, optionalAssets);
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

    const { Runtime, Client, OrchestrationContext, SqliteProvider, PostgresProvider } = require("duroxide");
    for (const api of [Runtime, Client, OrchestrationContext, SqliteProvider, PostgresProvider]) {
        assert.equal(typeof api, "function");
    }
    assert.equal(typeof SqliteProvider.inMemory, "function");
    assert.equal(typeof PostgresProvider.connectWithSchema, "function");
    assert.equal(typeof PostgresProvider.connectWithSchemaAndEntra, "function");
});
