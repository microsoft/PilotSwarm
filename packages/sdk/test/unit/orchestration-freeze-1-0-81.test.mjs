import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";

const read = name => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("registry freezes 1.0.81 and activates a separate 1.0.82 handler", () => {
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.81").handler.name, "durableSessionOrchestration_1_0_81");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).version, "1.0.82");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).handler.name, "durableSessionOrchestration_1_0_82");
    assert.match(read("orchestration-registry.ts"), /from "\.\/orchestration_1_0_81\/index\.js"/);
    assert.match(read("orchestration_1_0_81/runtime.ts"), /CURRENT_ORCHESTRATION_VERSION = "1\.0\.81"/);
    assert.match(read("orchestration_1_0_81/index.ts"), /latestVersion: DURABLE_SESSION_LATEST_VERSION/);
});

const frozenHashes = {
    "agents.ts": "5c208d8637bb3170258a8ea672f16efabcbf2621dc5d72fb5f66b4cbb884db06",
    "index.ts": "db78cb036b7aa0eb7cb47f64df64e3976e076fa1f51705cc9388ba694bd88499",
    "lifecycle.ts": "3d22fb3eaf14ded6e62b8e208b8fec56f81dcce73a6a9f5945598f952866550d",
    "queue.ts": "2af6f2b182edd09c9a27d211edbc82732426898a831220843212c5c37fe485e1",
    "runtime.ts": "8c5f61aed2140b432a4a86289e5951bad7b746478cff236522644755f1a8bacc",
    "state.ts": "ba8ca9e368c161f275fd69c828792cc3ce99739668ff429cea0a39764a42a160",
    "turn.ts": "61252a2658d909d90423e13b628ff2fb4054caebea0d7dbed973964fa9d3f92a",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
};
for (const [name, hash] of Object.entries(frozenHashes)) {
    test(`frozen 1.0.81 ${name} remains unchanged`, () => {
        assert.equal(createHash("sha256").update(read(`orchestration_1_0_81/${name}`)).digest("hex"), hash);
    });
}

test("only 1.0.82 consults a cron precheck before a cron wake-up", () => {
    assert.doesNotMatch(read("orchestration_1_0_81/turn.ts"), /runCronPrecheck/);
    assert.match(read("orchestration/turn.ts"), /runtime\.manager\.runCronPrecheck\(/);
});
