/**
 * Worker extension modules (PILOTSWARM_EXTENSION_MODULES): the stock worker
 * imports each listed module before start and calls its register(worker).
 * docs/proposals/session-workspaces.md, section 12.1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExtensionModules, parseExtensionModules } from "../../dist/extension-modules.js";

function moduleDir(t, files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-ext-modules-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return dir;
}

test("parses the comma list, trimming blanks", () => {
    assert.deepEqual(parseExtensionModules(" /a/one.js, ./two.mjs ,,pkg-three "), ["/a/one.js", "./two.mjs", "pkg-three"]);
    assert.deepEqual(parseExtensionModules(undefined), []);
    assert.deepEqual(parseExtensionModules(""), []);
});

test("loads modules in order and calls register(worker, context) on each export shape", async (t) => {
    const dir = moduleDir(t, {
        "named.mjs": "export async function register(worker, ctx) { worker.calls.push(['named', ctx.specifier, typeof ctx.log, ctx.env.PS_EXT_MARK]); worker.setWorkspaceProvider({ listRoots: async () => [] }); }",
        "default-object.mjs": "export default { register(worker) { worker.calls.push(['default-object']); } };",
        "default-fn.mjs": "export default function (worker) { worker.calls.push(['default-fn']); }",
    });
    const worker = { calls: [], provider: null, setWorkspaceProvider(p) { this.provider = p; } };
    const logs = [];
    const loaded = await loadExtensionModules(worker, [path.join(dir, "named.mjs"), "./default-object.mjs", "./default-fn.mjs"], {
        cwd: dir, env: { PS_EXT_MARK: "yes" }, log: (m) => logs.push(m),
    });
    assert.deepEqual(worker.calls.map((c) => c[0]), ["named", "default-object", "default-fn"]);
    assert.deepEqual(worker.calls[0].slice(1), [path.join(dir, "named.mjs"), "function", "yes"]);
    assert.ok(worker.provider, "the module set the workspace provider");
    assert.equal(loaded.length, 3);
    assert.equal(logs.length, 3);
});

test("a module that fails to load, has no register, or throws in register stops the load", async (t) => {
    const dir = moduleDir(t, {
        "none.mjs": "export const x = 1;",
        "throws.mjs": "export function register() { throw new Error('no roots configured'); }",
        "after.mjs": "export function register(worker) { worker.after = true; }",
    });
    const worker = {};
    await assert.rejects(loadExtensionModules(worker, [path.join(dir, "missing.mjs")]), /extension module .*missing\.mjs failed to load/);
    await assert.rejects(loadExtensionModules(worker, [path.join(dir, "none.mjs")]), /exports no register\(worker\) function/);
    await assert.rejects(loadExtensionModules(worker, [path.join(dir, "throws.mjs"), path.join(dir, "after.mjs")]), /failed in register\(\): no roots configured/);
    assert.equal(worker.after, undefined, "modules after a failure do not load");
});
