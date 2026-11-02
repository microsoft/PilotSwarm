/**
 * Freezing 1.0.82 and opening 1.0.83 (compute providers).
 *
 * A session that runs its agent on a compute host has its turns routed only
 * to workers that can drive a remote runtime, and the tag that does that is
 * chosen inside the orchestration. A worker running an older version of the
 * orchestration itself would not choose it, and would then run the turn as
 * its own child process beside the CMS and the model keys.
 *
 * So compute is gated on the orchestration version: 1.0.82 is frozen, an
 * old worker registers nothing newer and cannot run any step of a compute
 * session, and 1.0.83 is what every new session starts on. The frozen copy
 * must stay byte for byte what the previous build ran, because that is what
 * an in-flight 1.0.82 session replays against.
 *
 * Run: node --test test/unit/orchestration-freeze-1-0-82.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
import {
    COMPUTE_ORCHESTRATION_MIN_VERSION,
    DURABLE_SESSION_LATEST_VERSION,
    orchestrationSupportsCompute,
} from "../../dist/orchestration-version.js";

const read = name => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("registry freezes 1.0.82 and activates a separate 1.0.83 handler", () => {
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.82").handler.name, "durableSessionOrchestration_1_0_82");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).version, "1.0.83");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).handler.name, "durableSessionOrchestration_1_0_83");
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.83");
    assert.match(read("orchestration-registry.ts"), /from "\.\/orchestration_1_0_82\/index\.js"/);
    assert.match(read("orchestration_1_0_82/runtime.ts"), /CURRENT_ORCHESTRATION_VERSION = "1\.0\.82"/);
    assert.match(read("orchestration_1_0_82/index.ts"), /latestVersion: DURABLE_SESSION_LATEST_VERSION/);
    // The new frozen version must not follow the moving latest.
    assert.doesNotMatch(read("orchestration_1_0_82/runtime.ts"), /CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION/);
    assert.match(read("orchestration/runtime.ts"), /export const CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION;/);
});

const frozenHashes = {
    "agents.ts": "86c55f4f576d661b79858c11c0eff08d5652bb2152d18f19ef4123c656494250",
    "index.ts": "101af2bd2d9ccd133b9937b5359cee657e6abd15e481e4b389fb0e1e572ce02f",
    "lifecycle.ts": "bc3b61dc15eab0fd981bcbd8fd8c0a5e9ec9a7c1dddd23d0001e0c1b4a708417",
    "queue.ts": "7fe401187e31759022eca1ab1d29dcbd11e42084896ef924d54eb88d59296a83",
    "runtime.ts": "02fe84eccf301d28c76157af8f4b54fd1bfbdd155c9a3860250d32feca51654d",
    "state.ts": "b58bbdbec9debfd1e28cc1f1bd359aba33139478b2154c7005c3190627924986",
    "turn.ts": "9c11110bc861eea2109da120becaf4a58256bb761b811a204d2367ad23a5dbd6",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
};
for (const [name, hash] of Object.entries(frozenHashes)) {
    test(`frozen 1.0.82 ${name} remains unchanged`, () => {
        assert.equal(createHash("sha256").update(read(`orchestration_1_0_82/${name}`)).digest("hex"), hash);
    });
}

test("the frozen 1.0.82 never lets go of a compute host", () => {
    // Letting the worker a session leaves release its host is a yield of
    // its own, added in 1.0.83. A 1.0.82 history has no record of it.
    assert.doesNotMatch(read("orchestration_1_0_82/lifecycle.ts"), /releaseCompute/);
    assert.match(read("orchestration/lifecycle.ts"), /releaseCompute/);
});

test("only an orchestration that knows about compute may route a compute turn", () => {
    assert.equal(COMPUTE_ORCHESTRATION_MIN_VERSION, "1.0.83");
    assert.equal(orchestrationSupportsCompute("1.0.83"), true);
    assert.equal(orchestrationSupportsCompute("1.0.84"), true);
    assert.equal(orchestrationSupportsCompute("1.1.0"), true);
    assert.equal(orchestrationSupportsCompute("1.0.82"), false);
    assert.equal(orchestrationSupportsCompute("1.0.47"), false);
    // Not knowing is not a reason to open the gate.
    assert.equal(orchestrationSupportsCompute(undefined), false);
    assert.equal(orchestrationSupportsCompute("not a version"), false);

    // The latest orchestration passes its own version to the session proxy,
    // which is what makes the gate reachable at all.
    for (const file of ["orchestration/lifecycle.ts", "orchestration/turn.ts", "orchestration/runtime.ts"]) {
        assert.match(read(file), /createSessionProxy\([^)]*"turn-control-v1", CURRENT_ORCHESTRATION_VERSION\)/);
    }
    // The frozen copy schedules exactly what it always did.
    for (const file of ["orchestration_1_0_82/lifecycle.ts", "orchestration_1_0_82/turn.ts", "orchestration_1_0_82/runtime.ts"]) {
        assert.doesNotMatch(read(file), /"turn-control-v1", CURRENT_ORCHESTRATION_VERSION/);
    }
});
