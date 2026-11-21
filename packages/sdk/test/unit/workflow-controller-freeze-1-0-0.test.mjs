import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = process.env.WORKFLOW_FREEZE_SOURCE_ROOT
    ? pathToFileURL(`${resolve(process.env.WORKFLOW_FREEZE_SOURCE_ROOT)}/`) : new URL("../../src/", import.meta.url);
/** Rewrite only CRLF pairs; every other byte, including a lone CR, remains significant. */
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
        "index.ts": "b0f5516d9bd672f5eb8c17926ee181a3d0aa8210e247bf74c6314f7ece1dcf51",
        "runtime.ts": "cb5017b297470235ae84b82b97671090b380b1d1bca74c8e3388b7bbf017207b",
    },
    // b71f78d2e6c80603d4e3a2a43c756e4a03fe98fa, with the runtime's version fixed to 1.1.0.
    "1.1.0": {
        "index.ts": "5ff068778d8cdd127c9d042f8d11b3c3945fde439a00470807887979ffc62f0d",
        "runtime.ts": "df524372a4199401e64d12e4111768e4d5489ce2911cb5ec0e688199b70920ad",
    },
};
const frozenDir = version => `workflow/controller_${version.replaceAll(".", "_")}`;

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

test("frozen pins treat CRLF as LF but preserve every other byte", () => {
    const lf = Buffer.from("alpha\nbeta\n", "utf8");
    const crlf = Buffer.from("alpha\r\nbeta\r\n", "utf8");
    const loneCr = Buffer.from("alpha\rbeta\n", "utf8");
    assert.equal(pinnedSha256(crlf), pinnedSha256(lf));
    assert.notEqual(pinnedSha256(loneCr), pinnedSha256(lf));
    assert.notEqual(pinnedSha256(Buffer.from("alpha\ngamma\n", "utf8")), pinnedSha256(lf));
});

test("the importer fence also sees dynamic, require and side-effect imports", () => {
    assert.deepEqual(importsOf('const lazy = import("./controller_1_0_0/index.js");\nconst other = require("./controller_1_0_0/runtime.js");\nimport "./side-effect.js";'),
        ["./controller_1_0_0/index.js", "./controller_1_0_0/runtime.js", "./side-effect.js"]);
});

for (const [version, hashes] of Object.entries(frozenVersions)) {
    const frozen = frozenDir(version);
    const handler = `workflowController_${version.replaceAll(".", "_")}`;

    test(`${version} has a separate frozen controller and pure runtime`, () => {
        assert.deepEqual(readdirSync(new URL(`${frozen}/`, SRC)).sort(), ["index.ts", "runtime.ts"]);
        assert.ok(read(`${frozen}/index.ts`).includes(`export function* ${handler}(`));
        assert.ok(read(`${frozen}/runtime.ts`).split("\n").includes(`export const WORKFLOW_CONTROLLER_VERSION = "${version}";`));
        assert.ok(!read(`${frozen}/index.ts`).includes("workflowControllerFeatures"));
    });

    for (const [file, hash] of Object.entries(hashes)) {
        test(`frozen controller ${version} ${file} is unchanged`, () => {
            assert.equal(pinnedSha256(readBytes(`${frozen}/${file}`)), hash);
        });
    }

    test(`${version} imports nothing live but the latest version for its continue-as-new target`, () => {
        for (const file of ["index.ts", "runtime.ts"]) {
            const source = read(`${frozen}/${file}`);
            const allowed = specifier => file === "index.ts"
                && ["./runtime.js", "duroxide", "../controller-version.js"].includes(specifier);
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

    test(`only the registry imports frozen controller ${version}`, () => {
        const directory = frozen.split("/").at(-1);
        for (const file of sourceFiles()) {
            if (file.startsWith(`${frozen}/`)) continue;
            if (importsOf(read(file)).some(specifier => specifier.includes(directory))) {
                assert.equal(file, "workflow/controller-registry.ts");
            }
        }
        const registry = read("workflow/controller-registry.ts");
        assert.ok(registry.includes(`import { ${handler} } from "./${directory}/index.js";`));
        assert.ok(registry.includes(`{ version: "${version}", handler: ${handler} }`));
    });
}

test("the registry keeps both frozen versions and 1.2.0 is live", () => {
    const registry = read("workflow/controller-registry.ts");
    const versions = read("workflow/controller-version.ts");
    assert.match(versions, /^export const WORKFLOW_CONTROLLER_VERSION = "1\.2\.0";$/m);
    assert.match(versions, /^export const WORKFLOW_CONTROLLER_VERSIONS = \["1\.0\.0", "1\.1\.0", WORKFLOW_CONTROLLER_VERSION\] as const;$/m);
    assert.match(registry, /import \{ workflowController_1_2_0 \} from "\.\/controller\/index\.js";/);
    assert.match(registry, /\{ version: WORKFLOW_CONTROLLER_VERSION, handler: workflowController_1_2_0 \}/);
});

test("frozen and live continue-as-new target the shared latest version; live code has no feature gates", () => {
    for (const file of [...Object.keys(frozenVersions).map(version => `${frozenDir(version)}/index.ts`), "workflow/controller/index.ts"]) {
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
