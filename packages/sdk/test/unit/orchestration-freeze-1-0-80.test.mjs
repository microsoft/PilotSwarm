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
    assert.match(read("orchestration_1_0_80/lifecycle.ts"), /DURABLE_SESSION_LATEST_VERSION/);
});

test("frozen 1.0.80 keeps its Stop race and abort path", () => {
    const frozen = read("orchestration_1_0_80/turn.ts");
    assert.match(frozen, /stopTurn\./);
    assert.match(frozen, /ctx\.race/);
    assert.match(frozen, /abortTurn/);
    assert.doesNotMatch(frozen, /turn-control-v1|carriedSteers/);
});
