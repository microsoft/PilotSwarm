import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { packAgentPackage } from "../../dist/agent-package-format.js";
import { inspectAgentPackageArtifact } from "../../dist/agent-package-authorization.js";
import { installAgentPackages, loadAgentPackageTools } from "../../dist/agent-package-installer.js";

function fixture(t, files = {}, manifest = {}) {
    const root = fs.mkdtempSync(path.resolve(".test-package-authorization-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    const contents = {
        "plugin.json": JSON.stringify({ name: "review-kit", version: "1.0.0", description: "test", ...manifest }),
        "agents/helper.agent.md": "---\nname: helper\ndescription: helper\n---\nA declarative prompt.",
        ...files,
    };
    for (const [file, body] of Object.entries(contents)) {
        fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
        fs.writeFileSync(path.join(source, file), body);
    }
    const packed = packAgentPackage(source);
    const entry = {
        packageId: "pkg-1", versionId: "version-1", name: "review-kit", semver: "1.0.0",
        sha256: packed.sha256, artifactFilename: "review-kit.tar.gz", sizeBytes: packed.targz.length,
        scope: "shared", owner: null, manifest: JSON.parse(contents["plugin.json"]),
    };
    let manifestRows = [entry];
    let downloads = 0;
    const catalog = {
        agentRegistryEpoch: async () => 5,
        getAgentPackagesInstallManifest: async () => manifestRows,
    };
    const artifactStore = { downloadArtifact: async () => { downloads++; return { body: packed.targz }; } };
    return {
        root, packed, entry, catalog, artifactStore,
        get downloads() { return downloads; },
        setRows(rows) { manifestRows = rows; },
        install(cache = "cache") {
            return installAgentPackages({ catalog, artifactStore, cacheDir: path.join(root, cache) });
        },
    };
}

test("data-only inspection preserves declarative prompts and includes every config/file byte", async (t) => {
    const f = fixture(t, { "skills/guide/SKILL.md": "Knowledge only", "data.json": '{"x":1}',
        "LICENSE": "License metadata", "NOTICE": "Authorship notice", "package.json": '{"name":"metadata-only","type":"module"}' });
    const inspection = inspectAgentPackageArtifact(f.packed.targz, f.packed.sha256);
    assert.equal(inspection.executable, false);
    assert.equal(inspection.sha256, f.entry.sha256);
    assert.equal(inspection.files.length, 7);
    assert.equal(inspection.name, f.entry.name);
    const result = await f.install();
    assert.equal(result.packages[0].status, "ok");
    assert.equal(result.pluginDirs.length, 1);
    assert.deepEqual(await loadAgentPackageTools(result.packages[0], {}), []);
});

for (const [name, files, manifest] of [
    ["worker module", { "tools/worker-module.js": "throw new Error('must not import')" }, {}],
    ["MCP config", { ".mcp.json": '{"local":{"command":"node","args":["server.js"]}}' }, {}],
    ["MCP program", { "mcp-servers/server.js": "throw new Error('must not start')" }, {}],
    ["free-form handler", {}, { handlers: { run: { command: "arbitrary" } } }],
    ["future precheck", {}, { prechecks: [{ id: "guard", handler: "arbitrary" }] }],
    ["unverified dependencies", { "package.json": '{"dependencies":{"remote":"latest"}}' }, {}],
    ["unrecognized executable", { "payload": "executable bytes" }, {}],
]) {
    test(`${name} quarantines the WHOLE package before plugin registration, private or shared`, async (t) => {
        const f = fixture(t, files, manifest);
        const inspection = inspectAgentPackageArtifact(f.packed.targz, f.packed.sha256);
        assert.equal(inspection.executable, true);
        assert(inspection.approvalBlockers.length > 0);
        for (const scope of ["shared", "user"]) {
            f.entry.scope = scope;
            f.entry.owner = scope === "user" ? { provider: "entra", subject: "alice" } : null;
            f.entry.reviewDecision = "approved"; // neither scope nor stale approval is execution authority
            const result = await f.install();
            assert.equal(result.packages[0].status, "error");
            assert.match(result.packages[0].error, /EXECUTABLE_DENIED/);
            assert.deepEqual(result.pluginDirs, []);
        }
    });
}

test("real public tool loader: independent import/factory/callback/handler counters stay zero cold and warm", async (t) => {
    const key = `psPackageCounters${Date.now()}`;
    globalThis[key] = { imports: 0, factories: 0, callbacks: 0, handlers: 0 };
    t.after(() => { delete globalThis[key]; });
    const code = `
        globalThis.${key}.imports++;
        export const prechecks = [() => globalThis.${key}.callbacks++];
        export default { createTools() {
            globalThis.${key}.factories++;
            return [{ name: "danger", handler: () => globalThis.${key}.handlers++ }];
        } };
    `;
    const f = fixture(t, {
        "tools/worker-module.js": code,
        "mcp-servers/server.js": `import fs from "node:fs"; fs.appendFileSync(process.env.${key}, "started\\n");`,
        ".mcp.json": '{"danger":{"command":"node","args":["./mcp-servers/server.js"]}}',
    });
    const mcpMarker = path.join(f.root, "mcp-starts");
    process.env[key] = mcpMarker;
    t.after(() => { delete process.env[key]; });
    for (const cache of ["worker-a", "worker-a", "worker-b"]) {
        const result = await f.install(cache);
        assert.deepEqual(result.pluginDirs, []);
        const direct = {
            ...result.packages[0], status: "ok", workerModulePath: path.join(f.root, "source", "tools", "worker-module.js"),
            reviewDecision: "approved",
        };
        await assert.rejects(loadAgentPackageTools(direct, { workerNodeId: cache }), /EXECUTABLE_DENIED/);
    }
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    for (const id of ["actual-worker-a", "actual-worker-b"]) {
        const worker = new PilotSwarmWorker({
            store: "sqlite::memory:", workerNodeId: id, pluginDirs: [],
            sessionStateDir: path.join(f.root, id, "sessions"),
            modelProvidersPath: path.resolve("packages", "sdk", "test", "fixtures", "model-providers.test.json"),
            agentPackages: { cacheDir: path.join(f.root, id, "cache") },
        });
        worker._catalog = { ...f.catalog, workerHeartbeat: async () => {} };
        worker.artifactStore = f.artifactStore;
        try {
            for (let refresh = 0; refresh < 2; refresh++) {
                await worker.refreshAgentPackages({ force: true });
                assert.equal(worker._agentPackagesRefreshError, null);
                assert.equal(worker._packageDirOwners.size, 0);
                assert.equal(worker._agentPackageTools.size, 0);
                assert.equal(worker._agentPackagesInstalled["review-kit"].status, "error");
                assert.deepEqual(worker.config.pluginDirs, []);
            }
        } finally { await worker.stop(); }
    }
    f.entry.reviewDecision = "revoked";
    assert.deepEqual((await f.install()).pluginDirs, []);
    f.setRows([]); // disabled/deleted install manifests have no fallback package
    assert.deepEqual((await f.install()).pluginDirs, []);
    assert.deepEqual(globalThis[key], { imports: 0, factories: 0, callbacks: 0, handlers: 0 });
    assert.equal(fs.existsSync(mcpMarker), false, "a separate MCP process would leave a cross-process startup marker");
});

test("warm cache metadata is not integrity: repair changed prompt and injected MCP config without starting it", async (t) => {
    const f = fixture(t);
    const first = await f.install();
    const dir = first.pluginDirs[0];
    fs.writeFileSync(path.join(dir, "agents", "helper.agent.md"), "tampered");
    fs.writeFileSync(path.join(dir, ".mcp.json"), '{"injected":{"command":"untrusted"}}');
    const warm = await f.install();
    assert.equal(warm.packages[0].status, "ok");
    assert.equal(fs.existsSync(path.join(dir, ".mcp.json")), false);
    assert.match(fs.readFileSync(path.join(dir, "agents", "helper.agent.md"), "utf8"), /declarative prompt/);
    assert.equal(f.downloads, 2);
});

test("warm refresh fails closed on corrupted artifact, revoked candidate and digest/identity substitution", async (t) => {
    const f = fixture(t);
    await f.install();
    f.entry.reviewDecision = "revoked";
    assert.equal((await f.install()).packages[0].status, "error");
    delete f.entry.reviewDecision;
    const original = f.entry.sha256;
    f.entry.sha256 = "0".repeat(64);
    assert.equal((await f.install()).packages[0].status, "error");
    f.entry.sha256 = original;
    f.entry.semver = "2.0.0";
    assert.match((await f.install()).packages[0].error, /manifest identity mismatch/);
    assert.throws(() => inspectAgentPackageArtifact(f.packed.targz, "0".repeat(64)), /digest mismatch/);
});
