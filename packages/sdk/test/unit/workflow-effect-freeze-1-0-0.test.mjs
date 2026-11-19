import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = process.env.WORKFLOW_FREEZE_SOURCE_ROOT
    ? pathToFileURL(`${resolve(process.env.WORKFLOW_FREEZE_SOURCE_ROOT)}/`) : new URL("../../src/", import.meta.url);

/** Normalize only CRLF pairs. A lone CR and every other byte remain significant. */
function lfBytes(bytes) {
    const out = Buffer.allocUnsafe(bytes.length);
    let length = 0;
    for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) continue;
        out[length++] = bytes[index];
    }
    return out.subarray(0, length);
}

const readBytes = name => readFileSync(new URL(name, SRC));
const read = name => lfBytes(readBytes(name)).toString("utf8");
const pinnedSha256 = bytes => createHash("sha256").update(lfBytes(bytes)).digest("hex");
const frozenVersions = {
    "1.0.0": {
        directory: "workflow/effect_1_0_0",
        handler: "workflowEffect_1_0_0",
        sha256: "f1bbe95650a38eac60c638a3ffe69a205f08e9b75a7abd024467fb30bab0df77",
    },
    "1.1.0": {
        directory: "workflow/effect_1_1_0",
        handler: "workflowEffect_1_1_0",
        sha256: "e0ee6958eea7579d46d16b58cdfb4e229ebe4b9bc0b372fd1614c3f5c1ffac31",
    },
};

function sourceFiles(dir = "") {
    return readdirSync(new URL(dir || ".", SRC), { withFileTypes: true }).flatMap(entry => {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
    });
}

const importsOf = source => [...source.matchAll(/^(?:import|export)\b[^\n]*?\sfrom\s+["\x27]([^"\x27]+)["\x27]|^\}\s+from\s+["\x27]([^"\x27]+)["\x27]|\b(?:import|require)\s*\(\s*["\x27]([^"\x27]+)["\x27]|^\s*import\s+["\x27]([^"\x27]+)["\x27]/gm)]
    .map(match => match[1] ?? match[2] ?? match[3] ?? match[4]);

test("effect freeze pins normalize CRLF to LF and preserve every other byte", () => {
    const lf = Buffer.from("alpha\nbeta\n", "utf8");
    const crlf = Buffer.from("alpha\r\nbeta\r\n", "utf8");
    const loneCr = Buffer.from("alpha\rbeta\n", "utf8");
    assert.equal(pinnedSha256(crlf), pinnedSha256(lf));
    assert.notEqual(pinnedSha256(loneCr), pinnedSha256(lf));
    assert.notEqual(pinnedSha256(Buffer.from("alpha\ngamma\n", "utf8")), pinnedSha256(lf));
});

test("the effect importer fence sees dynamic, require and side-effect imports", () => {
    assert.deepEqual(importsOf(`const lazy = import("./effect_1_0_0/index.js");\nconst other = require("./effect_1_0_0/index.js");\nimport "./side-effect.js";`),
        ["./effect_1_0_0/index.js", "./effect_1_0_0/index.js", "./side-effect.js"]);
});

for (const [version, frozen] of Object.entries(frozenVersions)) {
    test(`${version} has a separate frozen effect module with only the erased duroxide type import`, () => {
        assert.deepEqual(readdirSync(new URL(`${frozen.directory}/`, SRC)).sort(), ["index.ts"]);
        const source = read(`${frozen.directory}/index.ts`);
        assert.equal(pinnedSha256(readBytes(`${frozen.directory}/index.ts`)), frozen.sha256);
        assert.match(source, new RegExp(`^export function\\* ${frozen.handler}\\(`, "m"));
        assert.ok(source.split("\n").includes(`export const WORKFLOW_EFFECT_${version.replaceAll(".", "_")}_VERSION = "${version}";`));
        assert.deepEqual(importsOf(source), ["duroxide"]);
        assert.equal(source.match(/^import type \{ OrchestrationContext, ScheduledTask \} from "duroxide";$/gm)?.length, 1);
        assert.ok(!/\b(?:import|require)\s*\(/.test(source));
        assert.ok(!/^\s*import\s+["\x27]/m.test(source));
    });

    test(`only the workflow runtime imports frozen effect ${version}`, () => {
        const directory = frozen.directory.split("/").at(-1);
        for (const file of sourceFiles()) {
            if (file.startsWith(`${frozen.directory}/`)) continue;
            if (importsOf(read(file)).some(specifier => specifier.includes(directory))) {
                assert.equal(file, "workflow/runtime.ts");
            }
        }
        const runtime = read("workflow/runtime.ts");
        assert.ok(runtime.includes(`from "./${directory}/index.js";`));
        const suffix = version.replaceAll(".", "_");
        assert.ok(runtime.includes(`runtime.registerOrchestrationVersioned(WORKFLOW_EFFECT_${suffix}_NAME, WORKFLOW_EFFECT_${suffix}_VERSION, ${frozen.handler});`));
    });
}

test("the 1.0 effect stays script-only and 1.1 Decision stays distinct", () => {
    const script = read("workflow/effect_1_0_0/index.ts");
    const decision = read("workflow/effect_1_1_0/index.ts");
    assert.ok(script.includes("WORKFLOW_ACTIVITIES.runScript"));
    assert.ok(!script.includes("workflow.runDecision"));
    assert.ok(decision.includes("WORKFLOW_ACTIVITIES.runDecision"));
    assert.ok(!decision.includes("workflow.runScript"));
    assert.ok(!script.includes("parseDecisionEffectInput"));
    assert.ok(decision.includes("expect(input.nodeType === \"decision\""));
    assert.notEqual(frozenVersions["1.0.0"].sha256, frozenVersions["1.1.0"].sha256);
});
