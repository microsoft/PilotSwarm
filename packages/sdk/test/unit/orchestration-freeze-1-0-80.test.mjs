import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
import { TURN_CONTROL_ORCHESTRATION_MIN_VERSION } from "../../dist/orchestration-version.js";

const read = name => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("registry freezes 1.0.80 and activates a separate 1.0.81 handler", () => {
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.80").handler.name, "durableSessionOrchestration_1_0_80");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).version, "1.0.81");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).handler.name, "durableSessionOrchestration_1_0_81");
    assert.equal(TURN_CONTROL_ORCHESTRATION_MIN_VERSION, "1.0.81");
    assert.match(read("orchestration-registry.ts"), /from "\.\/orchestration_1_0_80\/index\.js"/);
    assert.match(read("orchestration_1_0_80/runtime.ts"), /CURRENT_ORCHESTRATION_VERSION = "1\.0\.80"/);
    assert.match(read("orchestration_1_0_80/index.ts"), /latestVersion: DURABLE_SESSION_LATEST_VERSION/);
});

const frozenHashes = {
    "agents.ts": "0dd393eff03ed0ac56994b3595c33a92eb151b1ef6c3023c5b7a15364c723e1b",
    "index.ts": "e06fde79e3a1aec37c8662caacde59b69e6c811907af76021f01d27945cf046a",
    "lifecycle.ts": "b9b272b385f80ce477597b97839d06b4f7677a0991366bfc8b58a0fe3a3bc527",
    "queue.ts": "3045703385614adc465fb411893ff2c128f886a97eea410e2e6091d1248273e6",
    "runtime.ts": "0403ef2c81b5981f7987b293f26bbf1aaed79292fd7023769a7a88e73d060da7",
    "state.ts": "5035fdda1cc726bc16e701c58ec8fff52c5262c71c3011be812defd0cb0c5247",
    "turn.ts": "9aea8887f2dcc63e3d23b318e1c97acff0523610889fda5df2993cf168ab289b",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
};
for (const [name, hash] of Object.entries(frozenHashes)) {
    test(`frozen 1.0.80 ${name} remains unchanged`, () => {
        assert.equal(createHash("sha256").update(read(`orchestration_1_0_80/${name}`)).digest("hex"), hash);
    });
}

test("frozen 1.0.80 keeps its Stop race and abort path", () => {
    const frozen = read("orchestration_1_0_80/turn.ts");
    assert.match(frozen, /stopTurn\./);
    assert.match(frozen, /ctx\.race/);
    assert.match(frozen, /abortTurn/);
    assert.doesNotMatch(frozen, /turn-control-v1|carriedSteers/);
});
