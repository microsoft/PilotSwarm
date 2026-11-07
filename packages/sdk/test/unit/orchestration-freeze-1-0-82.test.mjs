/**
 * Freezing 1.0.82 for the durable workflow intake (orchestration 1.0.83,
 * inactive; design docs/proposals/workflow-durable-intake.md section 8,
 * decision intake-inactive-implementation).
 *
 * The intake changes the session orchestration's yields, so 1.0.82 is
 * frozen first: orchestration_1_0_82/ is a literal copy of the live
 * orchestration/, which still serves 1.0.82. Nothing is registered or routed
 * differently yet: the registry, the latest version, new starts and every
 * continue-as-new target are unchanged, and nothing imports the copy. When
 * 1.0.83 is activated, the registry moves 1.0.82 to this copy; until then
 * the copy must stay the live code exactly, with only its version literal.
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

test("the registry, the latest version and the live 1.0.82 handler are unchanged", () => {
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.82");
    const latest = DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1);
    assert.equal(latest.version, "1.0.82");
    assert.equal(latest.handler.name, "durableSessionOrchestration_1_0_82");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.filter(entry => entry.version === "1.0.82").length, 1);
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.filter(entry => compareVersions(entry.version, "1.0.82") > 0).length, 0);
    const registry = read("orchestration-registry.ts");
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_82 \} from "\.\/orchestration\/index\.js";/);
    assert.doesNotMatch(registry, /orchestration_1_0_82|orchestration_1_0_83/);
    assert.match(read("orchestration-version.ts"), /export const DURABLE_SESSION_LATEST_VERSION = "1\.0\.82";/);
});

test("the latest version is at or above every registered version", () => {
    for (const entry of DURABLE_SESSION_ORCHESTRATION_REGISTRY) {
        assert.ok(compareVersions(DURABLE_SESSION_LATEST_VERSION, entry.version) >= 0, `${entry.version} is above the latest ${DURABLE_SESSION_LATEST_VERSION}`);
    }
});

test("while the live orchestration serves 1.0.82, the frozen copy is that code, with only its version literal", () => {
    assert.deepEqual(tsFiles("orchestration_1_0_82"), tsFiles("orchestration"));
    for (const name of tsFiles("orchestration")) {
        const live = read(`orchestration/${name}`);
        const frozen = read(`orchestration_1_0_82/${name}`);
        if (name === "runtime.ts") {
            assert.equal(live.split(LIVE_VERSION_LINE).length, 2, "the live version line appears once");
            assert.equal(frozen, live.replace(LIVE_VERSION_LINE, FROZEN_VERSION_LINE), name);
        } else {
            assert.equal(frozen, live, name);
        }
    }
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

test("nothing imports the frozen 1.0.82 copy yet", () => {
    for (const path of allSourceFiles()) {
        if (path.startsWith("orchestration_1_0_82/")) continue;
        for (const specifier of importsOf(read(path))) {
            assert.ok(!specifier.includes("orchestration_1_0_82"), `${path} imports ${specifier}`);
        }
    }
});
