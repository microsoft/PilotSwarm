import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
import { createSessionProxy } from "../../dist/session-proxy.js";
import { COMPUTE_CAPABILITY, NATIVE_COMPUTE_CAPABILITY } from "../../dist/activity-routing.js";

// Verified against b0b5006's live modules, with only runtime CURRENT pinned to 1.0.83.
const frozen = {
    "agents.ts": "86c55f4f576d661b79858c11c0eff08d5652bb2152d18f19ef4123c656494250",
    "index.ts": "0bc9c34f5fc5e277a69a7dbb5dec0d0835b4453feb5a07cbd883c59b8a22c966",
    "lifecycle.ts": "d9aa1dc8be2b0f8c789d6d39c993dc2dac0fe4c14a9f70811207122f22a8d4b1",
    "queue.ts": "7fe401187e31759022eca1ab1d29dcbd11e42084896ef924d54eb88d59296a83",
    "runtime.ts": "7641cfa1465508eb4fb1cfca255b551a5decec9a999f4042e9b66c00cb43b810",
    "state.ts": "b58bbdbec9debfd1e28cc1f1bd359aba33139478b2154c7005c3190627924986",
    "turn.ts": "cfa45e5d4a261b6f8cdbec33ae98cd0f2c05bc71f378ba28b70a56b49104a657",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
};
for (const [file, hash] of Object.entries(frozen)) {
    test(`frozen 1.0.83 ${file} matches the pinned implementation`, () => {
        const content = readFileSync(new URL(`../../src/orchestration_1_0_83/${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
        assert.equal(createHash("sha256").update(content).digest("hex"), hash);
    });
}

test("native capability routing is new-version-only and unselected local descriptors are unchanged", () => {
    const ctx = {
        scheduleActivityOnSession(name, input, sessionId) {
            return { name, input, sessionId, withTag(tag) { return { ...this, tag }; } };
        },
    };
    const task = (version, config) => JSON.parse(JSON.stringify(createSessionProxy(ctx, "s", "affinity", config,
        "turn-control-v1", version).runTurn("fixture", false, 1)));
    assert.equal(task("1.0.83", { computeTarget: "shared/fixture" }).tag, COMPUTE_CAPABILITY);
    assert.equal(task("1.0.84", { computeTarget: "shared/fixture" }).tag, NATIVE_COMPUTE_CAPABILITY);
    assert.deepEqual(task("1.0.84", {}), task("1.0.83", {}));
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(row => row.version === "1.0.83").handler.name, "durableSessionOrchestration_1_0_83");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).version, "1.0.84");
});
