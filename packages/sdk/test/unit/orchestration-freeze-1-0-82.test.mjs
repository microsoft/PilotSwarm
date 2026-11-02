import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
import { DURABLE_SESSION_LATEST_VERSION } from "../../dist/orchestration-version.js";

const read = name => readFileSync(new URL(`../../src/orchestration_1_0_82/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const hashes = {
    "agents.ts": "86c55f4f576d661b79858c11c0eff08d5652bb2152d18f19ef4123c656494250",
    "index.ts": "f10da54f1ce7785f0929fd6cf681bcf6489e225cc08866ce97fe4175bd9a4075",
    "lifecycle.ts": "bc3b61dc15eab0fd981bcbd8fd8c0a5e9ec9a7c1dddd23d0001e0c1b4a708417",
    "queue.ts": "7fe401187e31759022eca1ab1d29dcbd11e42084896ef924d54eb88d59296a83",
    "runtime.ts": "02fe84eccf301d28c76157af8f4b54fd1bfbdd155c9a3860250d32feca51654d",
    "state.ts": "b58bbdbec9debfd1e28cc1f1bd359aba33139478b2154c7005c3190627924986",
    "turn.ts": "9c11110bc861eea2109da120becaf4a58256bb761b811a204d2367ad23a5dbd6",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
};
for (const [name, hash] of Object.entries(hashes)) {
    test(`frozen 1.0.82 ${name} retains its replay schedule`, () => {
        assert.equal(createHash("sha256").update(read(name)).digest("hex"), hash);
    });
}

test("registry retains the frozen handler and opens a distinct latest handler", () => {
    const frozen = DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(entry => entry.version === "1.0.82");
    const latest = DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1);
    assert.equal(frozen.handler.name, "durableSessionOrchestration_1_0_82");
    assert.equal(latest.version, DURABLE_SESSION_LATEST_VERSION);
    assert.equal(latest.handler.name, `durableSessionOrchestration_${DURABLE_SESSION_LATEST_VERSION.replaceAll(".", "_")}`);
    assert.notEqual(frozen.handler, latest.handler);
    assert.match(read("runtime.ts"), /CURRENT_ORCHESTRATION_VERSION = "1\.0\.82"/);
    assert.match(read("index.ts"), /latestVersion: DURABLE_SESSION_LATEST_VERSION/);
});
