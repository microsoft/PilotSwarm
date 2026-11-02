/**
 * The host component as a command (docs/proposals/compute-providers.md,
 * "The handshake and host component").
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readHandshakeSecret } from "../../dist/compute-host.js";
import { positiveWhole, wholeMilliseconds } from "../../dist/compute-host-cli.js";

test("the binding's secret leaves the environment as it is read", () => {
    const env = { PILOTSWARM_COMPUTE_HANDSHAKE_SECRET: "s".repeat(64), PATH: "/usr/bin" };
    assert.equal(readHandshakeSecret(env), "s".repeat(64));
    assert.equal("PILOTSWARM_COMPUTE_HANDSHAKE_SECRET" in env, false,
        "so nothing the component starts, the runtime included, inherits it");
    assert.equal(env.PATH, "/usr/bin", "and nothing else is touched");
});

test("an environment with no secret reads as none", () => {
    assert.equal(readHandshakeSecret({}), "");
});

test("--idle-timeout takes a whole number of milliseconds, and nothing else", () => {
    assert.equal(wholeMilliseconds(undefined, "idle-timeout", 1800000), 1800000, "left out, the default applies");
    assert.equal(wholeMilliseconds("0", "idle-timeout", 1800000), 0, "zero keeps the component up for ever");
    assert.equal(wholeMilliseconds(" 60000 ", "idle-timeout", 1800000), 60000);
    // Each of these used to become NaN, which set a timer of about a
    // millisecond: the component ended the moment it started.
    for (const bad of ["", "soon", "-1", "1.5", "1e3", "30s", "Infinity", "NaN"]) {
        assert.throws(() => wholeMilliseconds(bad, "idle-timeout", 1800000), /whole number of milliseconds/,
            `--idle-timeout ${JSON.stringify(bad)} must be refused, not quietly become a timer`);
    }
});

test("the copy limits take a whole number greater than zero", () => {
    assert.equal(positiveWhole(undefined, "copy-max-files"), undefined);
    assert.equal(positiveWhole("4096", "copy-max-files"), 4096);
    for (const bad of ["", "0", "-5", "lots", "1.5"]) {
        assert.throws(() => positiveWhole(bad, "copy-max-files"), /greater than zero/);
    }
});

test("the shipped command serves the side channel unless it is told not to", async () => {
    // A session with any skill folder or any MCP server needs it. A host
    // that refuses it leaves every one of those sessions without them,
    // so it is on by default.
    const source = await readFile(fileURLToPath(new URL("../../src/compute-host-cli.ts", import.meta.url)), "utf8");
    assert.match(source, /--no-services/, "and there is a way to turn it off");
    assert.match(source, /const servesControl = !argv\.includes\("--no-services"\)/);
});
