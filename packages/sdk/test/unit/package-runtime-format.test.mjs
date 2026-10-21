import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { packAgentPackage } from "../../dist/agent-package-format.js";
import { inspectAgentPackageArtifact } from "../../dist/agent-package-authorization.js";
import { verifyPackageRuntime } from "../../dist/package-runtime-format.js";

function inspect(t, files = {}) {
    const dir = fs.mkdtempSync(path.resolve(".test-runtime-format-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [name, text] of Object.entries({
        "plugin.json": '{"name":"runtime-kit","version":"1.0.0"}',
        "tools/worker-module.mjs": "export const createTools=()=>[];", ...files,
    })) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
    }
    const packed = packAgentPackage(dir);
    return { packed, inspection: inspectAgentPackageArtifact(packed.targz, packed.sha256) };
}

test("runtime closure pins full canonical artifact and accepts only packaged ESM relative dependencies/trusted builtin APIs", t => {
    const { packed, inspection } = inspect(t, {
        "tools/worker-module.mjs": 'import fs from "node:fs"; import {x} from "./helper.mjs"; export const createTools=()=>[];',
        "tools/helper.mjs": "export const x=1;",
    });
    assert.ok(inspection.execution);
    assert.deepEqual(inspection.execution.builtins, ["node:fs"]);
    assert.equal(inspection.execution.artifactSha256, packed.sha256);
    assert.throws(() => verifyPackageRuntime(packed.targz, "0".repeat(64)), /digest mismatch/);
});
for (const [label, files, reason] of [
    ["external import", { "tools/worker-module.mjs": 'import "external";' }, /Unverifiable executable dependency/],
    ["dynamic import", { "tools/worker-module.mjs": 'import("./other.mjs");' }, /Unsupported dynamic/],
    ["external process creation", { "tools/worker-module.mjs": 'import cp from "node:child_process";' }, /Unverifiable executable dependency/],
    ["runtime evaluation", { "tools/worker-module.mjs": 'eval("payload");' }, /Unsupported dynamic/],
    ["ambient .js module configuration", { "tools/other.js": "export const x=1;" }, /ambient module configuration/],
    ["native payload", { "payload.EXE": "unsupported" }, /Unsupported executable/],
    ["dependency manifest", { "package.json": '{"dependencies":{"remote":"latest"}}' }, /Unsupported dependency/],
    ["custom worker entry", { "plugin.json": '{"name":"runtime-kit","version":"1.0.0","workerModule":"outside"}' }, /noncanonical worker/],
    ["arbitrary MCP command", { ".mcp.json": '{"demo":{"command":"arbitrary","args":[]}}' }, /Unsupported or unverifiable/],
    ["unverified MCP runtime environment", { ".mcp.json": '{"demo":{"command":"node","args":["tools/worker-module.mjs"],"env":{"LD_PRELOAD":"outside"}}}' }, /Unsupported or unverifiable/],
    ["free-form callback", { "plugin.json": '{"name":"runtime-kit","version":"1.0.0","prechecks":[{"handler":"unknown"}]}' }, /Unsupported free-form/],
    ["free-form module callback export", { "tools/worker-module.mjs": 'export const prechecks=[()=>true];export const createTools=()=>[];' }, /Unsupported free-form callback export/],
    ["undeclared callback export", { "tools/worker-module.mjs": "export const callbacks=[];" }, /explicit reviewed callback declarations/],
    ["unknown runtime export", { "tools/worker-module.mjs": "export const executeAnything=()=>true;" }, /Unsupported worker module export/],
    ["wildcard runtime export", { "tools/worker-module.mjs": 'export * from "./helper.mjs";', "tools/helper.mjs": "export const tools=[];" }, /wildcard worker module exports/],
    ["prototype callback name", { "plugin.json": '{"name":"runtime-kit","version":"1.0.0","callbacks":{"__proto__":{"agents":["helper"]}}}' }, /Unsupported callback declaration/],
    ["legacy cron factory", { "tools/worker-module.mjs": "export const createCronPrechecks=()=>[];" }, /Unsupported worker module export/],
    ["legacy cron handler export", { "tools/worker-module.mjs": "export const cronPrechecks=[];" }, /Unsupported worker module export/],
    ["unreviewed cron callback", { "plugin.json": '{"name":"runtime-kit","version":"1.0.0","cronPrechecks":{"queue":{"callback":"unknown"}}}' }, /Unsupported cron precheck declaration/],
]) test(`runtime closure explicitly rejects ${label} without importing anything`, t => {
    const { inspection } = inspect(t, files);
    assert.equal(inspection.execution, undefined);
    assert.match(inspection.approvalBlockers.join("; "), reason);
});

test("reviewed callback declaration pins names, agent access and nested tool/MCP permissions without imports", t => {
    const { inspection } = inspect(t, {
        "plugin.json": '{"name":"runtime-kit","version":"1.0.0","callbacks":{"check":{"agents":["helper"],"tools":["ping"],"mcpServers":["demo"]}}}',
        "tools/worker-module.mjs": "export const createCallbacks=()=>[{name:'check',handler:async args=>args}];",
    });
    assert.deepEqual(inspection.execution.callbacks, { check: { agents: ["helper"], tools: ["ping"], mcpServers: ["demo"] } });
});

test("packaged type:module gives .js a closed module interpretation rather than inheriting parent configuration", t => {
    const { inspection } = inspect(t, { "package.json": '{"type":"module"}', "tools/helper.js": "export const x=1;" });
    assert.ok(inspection.execution);
});

test("cron policy is inspected data pinned with explicit callbacks; malformed/oversized policies cannot activate", t => {
    const manifest = { name: "runtime-kit", version: "1.0.0", callbacks: { check: { agents: ["helper"] } },
        cronPrechecks: { "queue-gate": { callback: "check", timeoutMs: 123, shadow: true, maxConsecutiveSkips: 5 } } };
    const files = { "tools/worker-module.mjs": "export const createCallbacks=()=>[];" };
    const { inspection } = inspect(t, { ...files, "plugin.json": JSON.stringify(manifest) });
    assert.deepEqual(inspection.execution.cronPrechecks, manifest.cronPrechecks);
    for (const invalid of [{ timeoutMs: 60001 }, { maxConsecutiveSkips: 0 }, { shadow: "yes" }, { check: "unreviewed.js" }]) {
        const bad = { ...manifest, cronPrechecks: { "queue-gate": { callback: "check", ...invalid } } };
        assert.equal(inspect(t, { ...files, "plugin.json": JSON.stringify(bad) }).inspection.execution, undefined);
    }
});
