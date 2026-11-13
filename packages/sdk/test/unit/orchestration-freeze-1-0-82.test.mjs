/**
 * Freezing 1.0.82 and opening 1.0.83 (the durable workflow intake; design
 * docs/proposals/workflow-durable-intake.md section 8; owner decision
 * 2026-11-08T15:30Z, pse/decision/always-on-scope-20261108T1530).
 *
 * The intake changes the session orchestration's yields, so 1.0.82 is frozen
 * in orchestration_1_0_82/ (the live code of v0.8.10 with only its version
 * literal) and in-flight 1.0.82 sessions keep replaying on it. The registry
 * registers it, and 1.0.83 (orchestration/) is the latest version: new starts
 * and every continue-as-new target it, the frozen copy's included.
 *
 * Run: node --test test/unit/orchestration-freeze-1-0-82.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";

const SRC = new URL("../../src/", import.meta.url);
const read = name => readFileSync(new URL(name, SRC), "utf8").replace(/\r\n/g, "\n");
const tsFiles = dir => readdirSync(new URL(`${dir}/`, SRC)).filter(name => name.endsWith(".ts")).sort();

/** Every .ts file under src, as paths relative to src. */
function allSourceFiles(dir = "") {
    const out = [];
    for (const name of readdirSync(new URL(dir || ".", SRC))) {
        const path = dir ? `${dir}/${name}` : name;
        if (statSync(new URL(path, SRC)).isDirectory()) out.push(...allSourceFiles(path));
        else if (name.endsWith(".ts")) out.push(path);
    }
    return out;
}

/** The module specifiers a source file imports: import/export ... from, a closing "} from", and import("...") types. */
function importsOf(text) {
    return [...text.matchAll(/^(?:import|export)\b[^\n]*?\sfrom\s+"([^"]+)"|^\}\s+from\s+"([^"]+)"|\bimport\("([^"]+)"\)/gm)]
        .map(match => match[1] ?? match[2] ?? match[3]);
}

const LIVE_VERSION_LINE = "export const CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION;";
const FROZEN_VERSION_LINE = 'export const CURRENT_ORCHESTRATION_VERSION = "1.0.82";';

function versionNumbers(version) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    return version.split(".").map(Number);
}

function compareVersions(a, b) {
    const [x, y] = [versionNumbers(a), versionNumbers(b)];
    for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return x[index] - y[index];
    return 0;
}

test("the registry keeps 1.0.82 and 1.0.83 frozen and registers 1.0.84 from the live tree", () => {
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.84");
    const frozen = DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(entry => entry.version === "1.0.82");
    assert.equal(frozen.handler.name, "durableSessionOrchestration_1_0_82");
    const latest = DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1);
    assert.deepEqual([latest.version, latest.handler.name], ["1.0.84", "durableSessionOrchestration_1_0_84"]);
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.filter(entry => entry.version === "1.0.82").length, 1);
    const registry = read("orchestration-registry.ts");
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_82 \} from "\.\/orchestration_1_0_82\/index\.js";/);
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_83 \} from "\.\/orchestration_1_0_83\/index\.js";/);
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_84 \} from "\.\/orchestration\/index\.js";/);
    assert.match(registry, /\{ version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_84 \}/);
    assert.match(read("orchestration-version.ts"), /export const DURABLE_SESSION_LATEST_VERSION = "1\.0\.84";/);
});

test("the latest version is at or above every registered version", () => {
    for (const entry of DURABLE_SESSION_ORCHESTRATION_REGISTRY) {
        assert.ok(compareVersions(DURABLE_SESSION_LATEST_VERSION, entry.version) >= 0, `${entry.version} is above the latest ${DURABLE_SESSION_LATEST_VERSION}`);
    }
});

test("the live tree names its version as the latest, never as a literal", () => {
    assert.equal(read("orchestration/runtime.ts").split(LIVE_VERSION_LINE).length, 2, "the live version line appears once");
    assert.ok(!read("orchestration/runtime.ts").includes(FROZEN_VERSION_LINE));
});

test("frozen 1.0.82 names its version as a literal and continues as new to the live latest", () => {
    assert.match(read("orchestration_1_0_82/runtime.ts"), /^export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.82";$/m);
    const index = read("orchestration_1_0_82/index.ts");
    assert.match(index, /latestVersion: DURABLE_SESSION_LATEST_VERSION/);
    assert.match(index, /export function\* durableSessionOrchestration_1_0_82\(/);
});

const frozenHashes = {
    "agents.ts": "86c55f4f576d661b79858c11c0eff08d5652bb2152d18f19ef4123c656494250",
    "index.ts": "f10da54f1ce7785f0929fd6cf681bcf6489e225cc08866ce97fe4175bd9a4075",
    "lifecycle.ts": "bc3b61dc15eab0fd981bcbd8fd8c0a5e9ec9a7c1dddd23d0001e0c1b4a708417",
    "queue.ts": "7fe401187e31759022eca1ab1d29dcbd11e42084896ef924d54eb88d59296a83",
    "runtime.ts": "02fe84eccf301d28c76157af8f4b54fd1bfbdd155c9a3860250d32feca51654d",
    "state.ts": "b58bbdbec9debfd1e28cc1f1bd359aba33139478b2154c7005c3190627924986",
    "turn.ts": "9c11110bc861eea2109da120becaf4a58256bb761b811a204d2367ad23a5dbd6",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
};

test("frozen 1.0.82 has exactly its files", () => {
    assert.deepEqual(tsFiles("orchestration_1_0_82"), Object.keys(frozenHashes).sort());
});

for (const [name, hash] of Object.entries(frozenHashes)) {
    test(`frozen 1.0.82 ${name} remains unchanged`, () => {
        assert.equal(createHash("sha256").update(read(`orchestration_1_0_82/${name}`)).digest("hex"), hash);
    });
}

/** The modules the frozen copy imports: shared ones and its own files, never the live orchestration or another version. */
const frozenImports = [
    "../child-notifications.js", "../cron-at.js", "../message-sender.js", "../orchestration-version.js", "../prompt-system-context.js",
    "../provider-budgets.js", "../session-list-timestamps.js", "../session-proxy.js", "../turn-control-contract.js", "../types.js",
    "../wait-affinity.js", "../workspace-check.js",
    "./agents.js", "./lifecycle.js", "./queue.js", "./runtime.js", "./state.js", "./turn.js", "./utils.js",
];

test("frozen 1.0.82 imports only shared modules and its own files", () => {
    const seen = new Set();
    for (const name of tsFiles("orchestration_1_0_82")) {
        for (const specifier of importsOf(read(`orchestration_1_0_82/${name}`))) {
            assert.ok(frozenImports.includes(specifier), `${name} imports ${specifier}`);
            seen.add(specifier);
        }
    }
    assert.deepEqual([...seen].sort(), [...frozenImports].sort());
});

test("only the registry imports the frozen 1.0.82 copy", () => {
    for (const path of allSourceFiles()) {
        if (path.startsWith("orchestration_1_0_82/")) continue;
        for (const specifier of importsOf(read(path))) {
            if (specifier.includes("orchestration_1_0_82")) assert.equal(path, "orchestration-registry.ts", `${path} imports ${specifier}`);
        }
    }
});
