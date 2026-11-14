import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = process.env.WORKFLOW_FREEZE_SOURCE_ROOT
    ? pathToFileURL(`${resolve(process.env.WORKFLOW_FREEZE_SOURCE_ROOT)}/`) : new URL("../../src/", import.meta.url);
const read = name => readFileSync(new URL(name, SRC), "utf8").replace(/\r\n/g, "\n");
const frozen = "workflow/controller_1_0_0";
const frozenHashes = {
    "index.ts": "b0f5516d9bd672f5eb8c17926ee181a3d0aa8210e247bf74c6314f7ece1dcf51",
    "runtime.ts": "cb5017b297470235ae84b82b97671090b380b1d1bca74c8e3388b7bbf017207b"
};

function sourceFiles(dir = "") {
    return readdirSync(new URL(dir || ".", SRC), { withFileTypes: true }).flatMap(entry => {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
    });
}

// FB-064: the one live value a frozen generator imports, as frozen session orchestrations import theirs: the latest
// version, for its continue-as-new target only.
const LATEST_IMPORT = 'import { WORKFLOW_CONTROLLER_VERSION as WORKFLOW_CONTROLLER_LATEST_VERSION } from "../controller-version.js"';

const importsOf = source => [...source.matchAll(/^(?:import|export)\b[^\n]*?\sfrom\s+["']([^"']+)["']|^\}\s+from\s+["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)]
    .map(match => match[1] ?? match[2] ?? match[3] ?? match[4]);

test("the importer fence also sees dynamic, require and side-effect imports", () => {
    assert.deepEqual(importsOf('const lazy = import("./controller_1_0_0/index.js");\nconst other = require("./controller_1_0_0/runtime.js");\nimport "./side-effect.js";'),
        ["./controller_1_0_0/index.js", "./controller_1_0_0/runtime.js", "./side-effect.js"]);
});

test("1.0.0 has a separate frozen controller and pure runtime", () => {
    assert.deepEqual(readdirSync(new URL(`${frozen}/`, SRC)).sort(), ["index.ts", "runtime.ts"]);
    assert.match(read(`${frozen}/index.ts`), /export function\* workflowController_1_0_0\(/);
    assert.match(read(`${frozen}/runtime.ts`), /^export const WORKFLOW_CONTROLLER_VERSION = "1\.0\.0";$/m);
    assert.ok(!read(`${frozen}/index.ts`).includes("workflowControllerFeatures"));
});

for (const [file, hash] of Object.entries(frozenHashes)) {
    test(`frozen controller 1.0.0 ${file} is unchanged`, () => {
        assert.equal(createHash("sha256").update(read(`${frozen}/${file}`)).digest("hex"), hash);
    });
}

test("the frozen controller imports nothing live but the latest version for its continue-as-new target", () => {
    for (const file of ["index.ts", "runtime.ts"]) {
        const source = read(`${frozen}/${file}`);
        const allowed = specifier => specifier === "./runtime.js" || specifier === "duroxide"
            || (file === "index.ts" && specifier === "../controller-version.js");
        for (const specifier of importsOf(source)) {
            assert.ok(allowed(specifier), `${file}: ${specifier}`);
        }
        assert.ok(!/^\s*import\s+["']/m.test(source), `${file}: side-effect import`);
        const imports = [...source.matchAll(/\b(?:import|export)[\s\S]*?\bfrom\s*["']([^"']+)["']/g)];
        for (const match of imports) {
            assert.ok(allowed(match[1]), `${file}: ${match[1]}`);
            if (match[1] === "duroxide") assert.match(match[0], /^import type /);
            if (match[1] === "../controller-version.js") assert.equal(match[0], LATEST_IMPORT, `${file}: only the latest version may be imported`);
        }
        assert.ok(!/\b(?:import|require)\s*\(/.test(source), `${file}: dynamic import`);
    }
});

test("only the registry imports frozen controller 1.0.0", () => {
    for (const file of sourceFiles()) {
        if (file.startsWith(`${frozen}/`)) continue;
        if (importsOf(read(file)).some(specifier => specifier.includes("controller_1_0_0"))) {
            assert.equal(file, "workflow/controller-registry.ts");
        }
    }
    const registry = read("workflow/controller-registry.ts");
    assert.match(registry, /import \{ workflowController_1_0_0 \} from "\.\/controller_1_0_0\/index\.js";/);
    assert.match(registry, /\{ version: "1\.0\.0", handler: workflowController_1_0_0 \}/);
    assert.match(registry, /\{ version: WORKFLOW_CONTROLLER_VERSION, handler: workflowController_1_1_0 \}/);
});

test("frozen and live continue-as-new target the shared latest version; live code has no feature gates", () => {
    for (const file of [`${frozen}/index.ts`, "workflow/controller/index.ts"]) {
        const source = read(file);
        assert.equal(source.split("\n").filter(line => line === `${LATEST_IMPORT};`).length, 1, `${file}: the latest version is imported under its own name`);
        assert.equal(source.match(/continueAsNewVersioned\(/g)?.length, 1, file);
        assert.match(source, /continueAsNewVersioned\([^;]*?\bWORKFLOW_CONTROLLER_LATEST_VERSION\);/, file);
        // The shared value is the continue-as-new target and nothing else: the import and that one use.
        assert.equal(source.match(/\bWORKFLOW_CONTROLLER_LATEST_VERSION\b/g)?.length, 2, file);
    }
    assert.ok(!read("workflow/controller/index.ts").includes("workflowControllerFeatures"));
    assert.match(read("workflow/controller/runtime.ts"), /WORKFLOW_CONTROLLER_VERSION/);
});
