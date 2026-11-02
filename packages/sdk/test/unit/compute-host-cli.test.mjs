/**
 * The host component as a command (docs/proposals/compute-providers.md,
 * "The handshake and host component").
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readHandshakeSecret } from "../../dist/compute-host.js";

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
