/**
 * Formal audit R1 (pse/wfv2/formal/latest-1083): every registered session orchestration version resolves to its own
 * module, exactly. 1.0.82 is the frozen copy (orchestration_1_0_82/, which names itself "1.0.82" and stamps that literal
 * as a continue-as-new's source version; audit R2); 1.0.83, the latest, is the live tree (orchestration/). Registering
 * the live tree's code under 1.0.82, or 1.0.82's under the latest, would hand in-flight histories the wrong handler.
 *
 * Run: node --test test/unit/orchestration-registry-modules.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
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

test("each registered version is its own module's handler, exactly; the latest (1.0.84) is the live tree", async () => {
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.84");
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
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).handler, live.durableSessionOrchestration_1_0_84);
    assert.equal("durableSessionOrchestration_1_0_82" in live, false, "the live tree is not 1.0.82");
});

test("audit R2: frozen 1.0.82 names itself with the literal 1.0.82 and stamps it as a continue-as-new's source version", () => {
    assert.match(readFileSync(new URL("orchestration_1_0_82/runtime.ts", SRC), "utf8"), /^export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.82";$/m);
    assert.match(readFileSync(new URL("orchestration_1_0_82/lifecycle.ts", SRC), "utf8"), /canInput\.sourceOrchestrationVersion = runtime\.versions\.currentVersion;/);
    assert.match(readFileSync(new URL("orchestration_1_0_82/index.ts", SRC), "utf8"), /currentVersion: CURRENT_ORCHESTRATION_VERSION,/);
});
