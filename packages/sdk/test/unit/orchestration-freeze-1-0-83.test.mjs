import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";

const SRC = new URL("../../src/", import.meta.url);
const read = path => readFileSync(new URL(path, SRC), "utf8").replace(/\r\n/g, "\n");
const files = readdirSync(new URL("orchestration_1_0_83/", SRC)).sort();
const hashes = {
    "agents.ts": "86c55f4f576d661b79858c11c0eff08d5652bb2152d18f19ef4123c656494250",
    "index.ts": "65a5140f3fb8e0e1a8abed66824304720dbefaba66a4a26a2e12ddee197e984e",
    "intake-machine.ts": "9a9cd67f531620445bcb26e24d8af1818772acfcb714a677f782e35f99e4e4bf",
    "intake-state.ts": "ba4e7de0ca9b17a6c43aaf094b107c7ff82dcc1dab7604444254c50811c351bf",
    "intake-wiring.ts": "e0fb80e51261152803667c99c72f8797ada8693946b237c740315d4cd65ce23d",
    "lifecycle.ts": "f61ea33b8e6c6799b6ccbc6733df09b027ce4434da5f912b55f93c46e39e7d27",
    "queue.ts": "24bc5edb4bc01798b2c63244c3ffc5451923da56214e29f4110d9c40e7d66803",
    "runtime.ts": "9428b8c8dc162fbb99158a1c27241059b3bf5d9ab525493b99e15cf0807b428a",
    "state.ts": "775105f65cd0cccfefa54f41e140d868deff1f7fd20cacd6d7f98db5660cbbf3",
    "turn.ts": "d576b28621965aee5cbcf49a0d7e4741714bb9fe6a7b681bbfd6ba2290795404",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "workflow-turn-failure.ts": "8f1f412f4caba5c7f3b5a4f688160d8425cd1548bcbb5b046066705824b7474a"
};
const allowedImports = [
    "../activity-routing.js",
    "../child-notifications.js",
    "../cron-at.js",
    "../message-sender.js",
    "../orchestration-version.js",
    "../prompt-system-context.js",
    "../provider-budgets.js",
    "../session-list-timestamps.js",
    "../session-proxy.js",
    "../turn-control-contract.js",
    "../types.js",
    "../wait-affinity.js",
    "../workflow/agent-ids.js",
    "../workflow/intake.js",
    "../workspace-check.js",
    "./agents.js",
    "./intake-machine.js",
    "./intake-state.js",
    "./intake-wiring.js",
    "./lifecycle.js",
    "./queue.js",
    "./runtime.js",
    "./state.js",
    "./turn.js",
    "./utils.js",
    "./workflow-turn-failure.js",
    "node:crypto"
];
const importsOf = text => [...text.matchAll(/^(?:import|export)\b[^\n]*?\sfrom\s+"([^"]+)"|^\}\s+from\s+"([^"]+)"|\bimport\("([^"]+)"\)/gm)]
    .map(match => match[1] ?? match[2] ?? match[3]);

function allSourceFiles(dir = "") {
    return readdirSync(new URL(dir || ".", SRC), { withFileTypes: true }).flatMap(entry => {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        return entry.isDirectory() ? allSourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
    });
}

test("1.0.83 stays registered from its frozen tree with its original version and proxy contract", () => {
    assert.deepEqual(files, Object.keys(hashes).sort());
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(entry => entry.version === "1.0.83").handler.name,
        "durableSessionOrchestration_1_0_83");
    assert.match(read("orchestration_1_0_83/runtime.ts"), /export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.83";/);
    assert.ok(read("orchestration_1_0_83/runtime.ts").includes('"workflow-intake-v1"'));
});

for (const [name, hash] of Object.entries(hashes)) {
    test(`frozen 1.0.83 ${name} is unchanged`, () => {
        assert.equal(createHash("sha256").update(read(`orchestration_1_0_83/${name}`)).digest("hex"), hash);
    });
}

test("frozen 1.0.83 uses only its pinned import allow-list", () => {
    const seen = new Set();
    for (const file of files) {
        for (const imported of importsOf(read(`orchestration_1_0_83/${file}`))) {
            assert.ok(allowedImports.includes(imported), `${file}: ${imported}`);
            seen.add(imported);
        }
    }
    assert.deepEqual([...seen].sort(), allowedImports);
});

test("only the registry imports frozen session orchestration 1.0.83", () => {
    for (const path of allSourceFiles()) {
        if (path.startsWith("orchestration_1_0_83/")) continue;
        for (const imported of importsOf(read(path))) {
            if (imported.includes("orchestration_1_0_83")) assert.equal(path, "orchestration-registry.ts");
        }
    }
});
