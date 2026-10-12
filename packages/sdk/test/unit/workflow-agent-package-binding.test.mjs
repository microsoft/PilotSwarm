import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packAgentPackage } from "../../dist/agent-package-format.js";
import { installAgentPackages } from "../../dist/agent-package-installer.js";

const PACKAGE_ROOT = fileURLToPath(
    new URL("../fixtures/workflow-package/", import.meta.url),
);

test("workflow version bindings install beside the active package copy", async () => {
    const packed = packAgentPackage(PACKAGE_ROOT);
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-workflow-agent-"));
    const entry = {
        name: "workflow-package-fixture",
        scope: "shared",
        owner: null,
        semver: "0.1.0",
        sha256: packed.sha256,
        sizeBytes: packed.targz.length,
        artifactFilename: "fixture.tar.gz",
        manifest: {},
    };
    try {
        const result = await installAgentPackages({
            catalog: {
                async agentRegistryEpoch() {
                    return 7;
                },
                async getAgentPackagesInstallManifest() {
                    return [
                        {
                            ...entry,
                            packageId: "package-fixture",
                            versionId: "version-active",
                            isActive: true,
                        },
                        {
                            ...entry,
                            packageId: "package-fixture",
                            versionId: "version-pinned",
                            isActive: false,
                            semver: "0.0.9",
                        },
                    ];
                },
            },
            artifactStore: {
                async downloadArtifact(_sessionId, filename) {
                    assert.equal(filename, "fixture.tar.gz");
                    return { body: packed.targz };
                },
            },
            cacheDir,
        });

        assert.equal(result.packages.length, 2);
        assert.deepEqual(
            result.packages.map(pkg => pkg.packageId),
            ["package-fixture", "package-fixture"],
        );
        assert.deepEqual(
            result.packages.map(pkg => pkg.versionId),
            ["version-active", "version-pinned"],
        );
        assert.notEqual(result.packages[0].dir, result.packages[1].dir);
        assert.ok(result.packages.every(pkg => pkg.status === "ok"));
        assert.ok(result.packages.every(pkg => fs.existsSync(pkg.dir)));
    } finally {
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});
