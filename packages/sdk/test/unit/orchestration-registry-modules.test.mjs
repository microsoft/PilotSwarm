/**
 * Formal audit R1 (pse/wfv2/formal/latest-1083): every registered session orchestration version resolves to its own
 * module, exactly. 1.0.82 is the frozen copy (orchestration_1_0_82/, which names itself "1.0.82" and stamps that literal
 * as a continue-as-new's source version; audit R2); 1.0.84, the latest, is the live tree (orchestration/). Registering
 * the live tree's code under 1.0.82, or 1.0.82's under the latest, would hand in-flight histories the wrong handler.
 *
 * Run: node --test test/unit/orchestration-registry-modules.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";

const DIST = new URL("../../dist/", import.meta.url);
const SRC = new URL("../../src/", import.meta.url);

/** The module a version's code lives in: the live tree for the latest; else its own file (to 1.0.51) or directory. */
function moduleOf(version) {
    if (version === DURABLE_SESSION_LATEST_VERSION) return "orchestration/index.js";
    const name = `orchestration_${version.replaceAll(".", "_")}`;
    return existsSync(new URL(`${name}/index.js`, DIST)) ? `${name}/index.js` : `${name}.js`;
}

test("each registered version is its own module's handler, exactly; the latest (1.0.86) is the live tree", async () => {
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.86");
    const versions = DURABLE_SESSION_ORCHESTRATION_REGISTRY.map(entry => entry.version);
    assert.equal(new Set(versions).size, versions.length, "no version is registered twice");
    assert.equal(versions.at(-1), DURABLE_SESSION_LATEST_VERSION);
    for (const { version, handler } of DURABLE_SESSION_ORCHESTRATION_REGISTRY) {
        const name = `durableSessionOrchestration_${version.replaceAll(".", "_")}`;
        const mod = await import(new URL(moduleOf(version), DIST).href);
        assert.equal(handler, mod[name], `${version} is ${moduleOf(version)}'s ${name}`);
        assert.equal(handler.name, name, version);
    }
    const frozen = await import(new URL("orchestration_1_0_82/index.js", DIST).href);
    const live = await import(new URL("orchestration/index.js", DIST).href);
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(entry => entry.version === "1.0.82").handler, frozen.durableSessionOrchestration_1_0_82);
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).handler, live.durableSessionOrchestration_1_0_86);
    assert.equal("durableSessionOrchestration_1_0_82" in live, false, "the live tree is not 1.0.82");
});

test("audit R2: frozen 1.0.82 names itself with the literal 1.0.82 and stamps it as a continue-as-new's source version", () => {
    assert.match(readFileSync(new URL("orchestration_1_0_82/runtime.ts", SRC), "utf8"), /^export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.82";$/m);
    assert.match(readFileSync(new URL("orchestration_1_0_82/lifecycle.ts", SRC), "utf8"), /canInput\.sourceOrchestrationVersion = runtime\.versions\.currentVersion;/);
    assert.match(readFileSync(new URL("orchestration_1_0_82/index.ts", SRC), "utf8"), /currentVersion: CURRENT_ORCHESTRATION_VERSION,/);
});

const upstream85Hashes = {
    "agents.ts": "e9c916e083e747bd2c41298620f26152b15d2066a2d3e248b1847876a807742b",
    "index.ts": "b51e1c2a8a8af47d5fd64f4799a57b29c99591cc3be3443f9ef8aaa5c54f8b2f",
    "intake-machine.ts": "9a9cd67f531620445bcb26e24d8af1818772acfcb714a677f782e35f99e4e4bf",
    "intake-state.ts": "ba4e7de0ca9b17a6c43aaf094b107c7ff82dcc1dab7604444254c50811c351bf",
    "intake-wiring.ts": "e0fb80e51261152803667c99c72f8797ada8693946b237c740315d4cd65ce23d",
    "lifecycle.ts": "f7e66df3ab43db58fe582c97d28a6be625c9cf5fb4141e1fe3cd17fc8a6db364",
    "proxy-contract.ts": "ba30ecb4405e568da4de5ee171ae8e84d0f4ff9384386547934025ff0d82f851",
    "queue.ts": "24bc5edb4bc01798b2c63244c3ffc5451923da56214e29f4110d9c40e7d66803",
    "runtime.ts": "32d0edb7180226041087877c8ca30dedeb2cb85b2f310b5677e3f2e07d42d9b8",
    "state.ts": "775105f65cd0cccfefa54f41e140d868deff1f7fd20cacd6d7f98db5660cbbf3",
    "turn.ts": "be3b403d2291d657ed1612dfe7bdc0ce85b3108fb30b98348241bde8b84e2643",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "workflow-turn-failure.ts": "8f1f412f4caba5c7f3b5a4f688160d8425cd1548bcbb5b046066705824b7474a"
};

test("upstream 1.0.85 remains byte-pinned, including its non-signal proxy contract", () => {
    const frozen = DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(entry => entry.version === "1.0.85");
    assert.equal(frozen.handler.name, "durableSessionOrchestration_1_0_85");
    for (const [name, expected] of Object.entries(upstream85Hashes)) {
        const content = readFileSync(new URL(`orchestration_1_0_85/${name}`, SRC), "utf8").replace(/\r\n/g, "\n");
        assert.equal(createHash("sha256").update(content).digest("hex"), expected, name);
    }
    assert.match(readFileSync(new URL("orchestration_1_0_85/proxy-contract.ts", SRC), "utf8"), /"tool-composition-v1"/);
    assert.match(readFileSync(new URL("orchestration/proxy-contract.ts", SRC), "utf8"), /"signals-v1"/);
});
