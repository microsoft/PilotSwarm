import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packAgentPackage } from "../../dist/agent-package-format.js";
import { installAgentPackages, loadAgentPackageTools } from "../../dist/agent-package-installer.js";
import {
    loadWorkflowTransitionRegistrationFromSnapshot,
    materializeWorkflowPackageSnapshot,
} from "../../dist/workflow-orchestration/package-loader.js";
import { assertPackagePolicy } from "../../dist/package-policy.js";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { packageAgentKey } from "../../dist/session-manager.js";

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-package-policy-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const previous = process.env.PILOTSWARM_PACKAGE_POLICY_MODULE;
    t.after(() => {
        if (previous === undefined) delete process.env.PILOTSWARM_PACKAGE_POLICY_MODULE;
        else process.env.PILOTSWARM_PACKAGE_POLICY_MODULE = previous;
    });
    const packageRoot = path.join(root, "package");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(path.join(packageRoot, "plugin.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    const approvals = path.join(root, "approved.json");
    fs.writeFileSync(approvals, "[]");
    const policy = path.join(root, "policy.mjs");
    fs.writeFileSync(policy, `
        import fs from "node:fs";
        export function authorizePackage({ packageSha256 }) {
            if (!JSON.parse(fs.readFileSync(${JSON.stringify(approvals)}, "utf8")).includes(packageSha256)) {
                throw new Error("host policy denied");
            }
        }
    `);
    process.env.PILOTSWARM_PACKAGE_POLICY_MODULE = policy;
    const sentinel = path.join(root, "executed");
    const code = `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(sentinel)}, "imported\\n");`;
    return {
        root: packageRoot, sentinel, code,
        approve: (hashes) => fs.writeFileSync(approvals, JSON.stringify(hashes)),
    };
}

function installerOptions(root, packed) {
    return {
        cacheDir: path.join(root, "cache"),
        catalog: {
            async agentRegistryEpoch() { return 1; },
            async workerHeartbeat() {},
            async getAgentPackagesInstallManifest() {
                return [{
                    packageId: "package", versionId: "version", isActive: true,
                    name: "fixture", semver: "1.0.0", sha256: packed.sha256,
                    scope: "shared", owner: null, manifest: {}, artifactFilename: "fixture.tar.gz",
                }];
            },
        },
        artifactStore: { async downloadArtifact() { return { body: packed.targz }; } },
    };
}

test("registry admission and direct tool loading reject before module initialization", async (t) => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.root, "tools"));
    fs.writeFileSync(path.join(f.root, "tools", "worker-module.js"), `${f.code}\nexport const tools = [];`);
    const packed = packAgentPackage(f.root);
    const opts = installerOptions(path.dirname(f.root), packed);
    const denied = await installAgentPackages(opts);
    assert.equal(denied.packages[0].status, "error");
    assert.match(denied.packages[0].error, /host policy denied/);
    assert.deepEqual(denied.pluginDirs, []);
    assert.equal(fs.existsSync(f.sentinel), false);
    f.approve([packed.sha256]);
    const allowed = await installAgentPackages(opts);
    assert.equal(allowed.packages[0].status, "ok");
    f.approve([]);
    await assert.rejects(loadAgentPackageTools(allowed.packages[0], {}), /host policy denied/);
    assert.equal(fs.existsSync(f.sentinel), false);
});

test("warm registry caches revalidate bytes rather than trusting their SHA sidecar", async (t) => {
    const f = fixture(t);
    const packed = packAgentPackage(f.root);
    f.approve([packed.sha256]);
    const opts = installerOptions(path.dirname(f.root), packed);
    const installed = await installAgentPackages(opts);
    assert.equal(installed.packages[0].status, "ok");
    fs.writeFileSync(path.join(installed.packages[0].dir, "tampered.mjs"), f.code);
    const refreshed = await installAgentPackages(opts);
    assert.equal(refreshed.packages[0].status, "error");
    assert.match(refreshed.packages[0].error, /content does not match/);
    assert.equal(fs.existsSync(f.sentinel), false);
});

test("unapproved workflow registration never initializes transition JavaScript", async (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, "transition.mjs"), `${f.code}
        export const next = { allowedTargets: ["done"], handler: () => ({kind: "advance", target: "done"}) };`);
    await assert.rejects(materializeWorkflowPackageSnapshot(f.root), /host policy denied/);
    assert.equal(fs.existsSync(f.sentinel), false);
    const packed = packAgentPackage(f.root);
    await assert.rejects(loadWorkflowTransitionRegistrationFromSnapshot({
        root: f.root, packageSha256: packed.sha256,
    }, { module: "./transition.mjs", export: "next" }), /host policy denied/);
    assert.equal(fs.existsSync(f.sentinel), false);
});

test("approved workflow transitions run, but revocation and changed cached bytes fail closed", async (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, "transition.mjs"), `${f.code}
        export const next = { allowedTargets: ["done"], handler: () => ({kind: "advance", target: "done"}) };`);
    const packed = packAgentPackage(f.root);
    f.approve([packed.sha256]);
    const snapshot = await materializeWorkflowPackageSnapshot(f.root);
    const reference = { module: "./transition.mjs", export: "next" };
    const registration = await loadWorkflowTransitionRegistrationFromSnapshot(snapshot, reference);
    assert.deepEqual(await registration.handler({}), { kind: "advance", target: "done" });
    assert.equal(fs.readFileSync(f.sentinel, "utf8"), "imported\n");
    f.approve([]);
    await assert.rejects(loadWorkflowTransitionRegistrationFromSnapshot(snapshot, reference), /host policy denied/);
    f.approve([packed.sha256]);
    const cachedModule = path.join(snapshot.root, "transition.mjs");
    const original = fs.readFileSync(cachedModule);
    try {
        fs.appendFileSync(cachedModule, "\n// changed bytes");
        await assert.rejects(loadWorkflowTransitionRegistrationFromSnapshot(snapshot, reference), /content does not match/);
    } finally { fs.writeFileSync(cachedModule, original); }
    assert.equal(fs.readFileSync(f.sentinel, "utf8"), "imported\n");
});

test("configured policy modules cannot be missing or omit the required export", async (t) => {
    const f = fixture(t);
    const input = { kind: "agent", root: f.root, packageSha256: packAgentPackage(f.root).sha256 };
    process.env.PILOTSWARM_PACKAGE_POLICY_MODULE = "relative-policy.mjs";
    await assert.rejects(assertPackagePolicy(input), /must be an absolute path/);
    process.env.PILOTSWARM_PACKAGE_POLICY_MODULE = path.join(f.root, "missing.mjs");
    await assert.rejects(assertPackagePolicy(input), /Cannot find module/);
    const invalid = path.join(path.dirname(f.root), "invalid.mjs");
    fs.writeFileSync(invalid, "export const wrong = true;");
    process.env.PILOTSWARM_PACKAGE_POLICY_MODULE = invalid;
    await assert.rejects(assertPackagePolicy(input), /must export authorizePackage/);
    delete process.env.PILOTSWARM_PACKAGE_POLICY_MODULE;
    await assertPackagePolicy(input);
});

test("deployment-only registry refresh preserves catalog references, restrictions and private ownership", async (t) => {
    const f = fixture(t);
    delete process.env.PILOTSWARM_PACKAGE_POLICY_MODULE;
    const deployment = path.join(path.dirname(f.root), "deployment");
    fs.mkdirSync(deployment);
    fs.writeFileSync(path.join(deployment, ".mcp.json"), JSON.stringify({
        approved: { type: "http", url: "https://approved.example/mcp", tools: ["*"] },
        restricted: { type: "http", url: "https://restricted.example/mcp", tools: ["*"], allowedAgents: ["deployment-agent"] },
    }));
    fs.mkdirSync(path.join(f.root, "agents"));
    fs.writeFileSync(path.join(f.root, "agents", "helper.agent.md"),
        "---\nschemaVersion: 2\nversion: 1.0.0\nname: helper\nmcpServers: [approved, restricted, caller]\n---\nHelp.");
    fs.writeFileSync(path.join(f.root, "agents", "inline.agent.md"),
        "---\nschemaVersion: 2\nversion: 1.0.0\nname: inline\nmcpServers:\n  caller:\n    url: https://unapproved.invalid/mcp\n    command: node\n---\nHelp.");
    fs.writeFileSync(path.join(f.root, ".mcp.json"), JSON.stringify({
        caller: { type: "stdio", command: "node", args: ["caller.js"], env: { TOKEN: "not-approved" } },
    }));
    fs.mkdirSync(path.join(f.root, "tools"));
    fs.writeFileSync(path.join(f.root, "tools", "worker-module.js"), `${f.code}\nexport const tools = [];`);
    const packed = packAgentPackage(f.root);
    const opts = installerOptions(path.dirname(f.root), packed);
    const owner = { provider: "dev", subject: "owner" };
    const getManifest = opts.catalog.getAgentPackagesInstallManifest;
    opts.catalog.getAgentPackagesInstallManifest = async () =>
        (await getManifest()).map(entry => ({ ...entry, scope: "user", owner }));
    const worker = new PilotSwarmWorker({
        sessionStateDir: path.join(path.dirname(f.root), "state"),
        pluginDirs: [deployment],
        agentPackages: { cacheDir: opts.cacheDir, mcpServers: "deployment-only", workerModules: "disabled" },
    });
    worker._catalog = opts.catalog;
    worker.artifactStore = opts.artifactStore;
    for (let i = 0; i < 2; i++) {
        await worker.refreshAgentPackages({ force: true, throwOnError: true });
        const key = packageAgentKey("package", "helper", "version");
        const map = worker.agentMcpServers[key];
        assert.deepEqual(Object.keys(map), ["approved"]);
        assert.equal(map.approved.url, "https://approved.example/mcp");
        assert.equal(worker.loadedMcpServers.caller, undefined);
        assert.equal(worker.agentMcpServers[packageAgentKey("package", "inline", "version")], undefined);
        assert.deepEqual(worker._packageDirOwners.get(path.resolve(worker.config.pluginDirs[1])).owner, owner);
        assert.equal(fs.existsSync(f.sentinel), false);
    }
});
