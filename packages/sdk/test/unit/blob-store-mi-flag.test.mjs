import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createSessionBlobStore, SessionBlobStore } from "../../dist/blob-store.js";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { resolveStorageConfig } from "../../dist/storage-config.js";

const ACCOUNT_URL = "https://example.blob.core.windows.net";
const CONNECTION_STRING =
    "DefaultEndpointsProtocol=https;AccountName=example;AccountKey=dGVzdGtleTEyMw==;EndpointSuffix=core.windows.net";

test("blob identity selection has explicit, backward-compatible precedence", async (t) => {
    await t.test("the blob-specific flag can enable identity independently", () => {
        const store = createSessionBlobStore({
            PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "1",
            PILOTSWARM_USE_MANAGED_IDENTITY: "0",
            AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
        });
        assert.ok(store instanceof SessionBlobStore);
    });

    await t.test("the legacy shared flag remains the default", () => {
        const store = createSessionBlobStore({
            PILOTSWARM_USE_MANAGED_IDENTITY: "1",
            AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
        });
        assert.ok(store instanceof SessionBlobStore);
    });

    await t.test("an explicit false blob flag wins and permits a connection string", () => {
        const store = createSessionBlobStore({
            PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "0",
            PILOTSWARM_USE_MANAGED_IDENTITY: "1",
            AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
            AZURE_STORAGE_CONNECTION_STRING: CONNECTION_STRING,
        });
        assert.ok(store instanceof SessionBlobStore);
    });

    await t.test("an explicit true blob flag wins over a connection string", () => {
        assert.throws(
            () => createSessionBlobStore({
                PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "1",
                PILOTSWARM_USE_MANAGED_IDENTITY: "0",
                AZURE_STORAGE_CONNECTION_STRING: CONNECTION_STRING,
            }),
            /AZURE_STORAGE_ACCOUNT_URL is not/,
        );
    });
});

test("configured account URLs never fall back without credentials", async (t) => {
    await t.test("an account URL alone is rejected", () => {
        assert.throws(
            () => createSessionBlobStore({ AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL }),
            /no blob credential path is enabled/,
        );
    });

    await t.test("an explicit false blob flag does not revive the shared flag", () => {
        assert.throws(
            () => createSessionBlobStore({
                PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "0",
                PILOTSWARM_USE_MANAGED_IDENTITY: "1",
                AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
            }),
            /no blob credential path is enabled/,
        );
    });

    await t.test("a connection string remains a credential path", () => {
        const store = createSessionBlobStore({
            AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
            AZURE_STORAGE_CONNECTION_STRING: CONNECTION_STRING,
        });
        assert.ok(store instanceof SessionBlobStore);
    });

    await t.test("empty configuration still selects filesystem storage", () => {
        assert.equal(createSessionBlobStore({}), null);
    });
});

test("worker options separate blob and database identity decisions", async (t) => {
    await t.test("database identity can coexist with filesystem artifacts", () => {
        assert.doesNotThrow(() => new PilotSwarmWorker({
            store: "sqlite::memory:",
            useManagedIdentity: true,
            blobUseManagedIdentity: false,
        }));
    });

    await t.test("blob identity can be enabled without database identity", () => {
        const worker = new PilotSwarmWorker({
            store: "sqlite::memory:",
            useManagedIdentity: false,
            blobUseManagedIdentity: true,
            blobAccountUrl: ACCOUNT_URL,
        });
        assert.ok(worker.blobStore instanceof SessionBlobStore);
    });

    await t.test("legacy worker configuration still enables both", () => {
        const worker = new PilotSwarmWorker({
            store: "sqlite::memory:",
            useManagedIdentity: true,
            blobAccountUrl: ACCOUNT_URL,
        });
        assert.ok(worker.blobStore instanceof SessionBlobStore);
    });
});

for (const [label, options] of [
    ["password DB and Blob identity", { useManagedIdentity: false, blobUseManagedIdentity: true }],
    ["legacy shared identity", { useManagedIdentity: true }],
]) {
    test(`real worker constructor supports ${label}`, async () => {
        const root = mkdtempSync(join(tmpdir(), "ps-worker-blob-auth-"));
        const modelProvidersPath = join(root, "models.json");
        writeFileSync(modelProvidersPath, JSON.stringify({ providers: [{
            id: "test-copilot", type: "github", githubToken: "fixture-token",
            models: [{ name: "gpt-5.6-terra" }],
        }] }));
        let worker;
        try {
            const config = {
                store: "postgresql://u:p@unittest.invalid/app",
                blobAccountUrl: ACCOUNT_URL,
                sessionStateDir: join(root, "session-state"),
                modelProvidersPath, pluginDirs: [], ...options,
            };
            worker = new PilotSwarmWorker(config);
            assert.ok(worker.blobStore instanceof SessionBlobStore);
            const storage = resolveStorageConfig({ env: {}, options: config });
            assert.equal(storage.runtime.useManagedIdentity, options.useManagedIdentity);
            assert.equal(storage.duroxide.useManagedIdentity, options.useManagedIdentity);
        } finally {
            await worker?.sessionManager.shutdown();
            rmSync(root, { recursive: true, force: true });
        }
    });
}

test("worker Blob override false is not lost to truthy database identity", () => {
    assert.throws(() => new PilotSwarmWorker({
        store: "postgresql://u@unittest.invalid/app",
        useManagedIdentity: true, blobUseManagedIdentity: false, blobAccountUrl: ACCOUNT_URL,
    }), /no blob credential path is enabled/);
});

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
for (const entrypoint of ["packages/sdk/examples/worker.js", "packages/app/tui/src/embedded-workers.js"]) {
    for (const [flag, expected] of [["1", true], [" FALSE ", false], [undefined, undefined]]) {
        test(`${entrypoint} forwards Blob flag ${String(flag)} independently of database auth`, () => {
            const sdkUrl = new URL("../../dist/index.js", import.meta.url).href;
            const entryUrl = new URL(entrypoint, new URL("../../../../", import.meta.url)).href;
            const script = `
                import { mock } from "node:test";
                mock.module(${JSON.stringify(sdkUrl)}, { namedExports: {
                    horizonConfigFromEnv: () => ({}),
                    loadTurnLifecycleHooksFromEnv: async () => undefined,
                    // Both entry points load extension modules before start.
                    loadExtensionModules: async () => [],
                    parseExtensionModules: () => [],
                    PilotSwarmWorker: class {
                        constructor(options) { this.options = options; }
                        async start() {
                            process.stdout.write("AUTH_OPTIONS:" + JSON.stringify({
                                db: this.options.useManagedIdentity, blob: this.options.blobUseManagedIdentity
                            }) + "\\n");
                            process.exit(0);
                        }
                    }
                } });
                const entry = await import(${JSON.stringify(entryUrl)});
                if (entry.startEmbeddedWorkers) await entry.startEmbeddedWorkers({count: 1, store: process.env.DATABASE_URL});
            `;
            const env = {
                ...process.env,
                DATABASE_URL: "postgresql://u:p@unittest.invalid/app",
                PILOTSWARM_USE_MANAGED_IDENTITY: "0",
            };
            if (flag === undefined) delete env.PILOTSWARM_BLOB_USE_MANAGED_IDENTITY;
            else env.PILOTSWARM_BLOB_USE_MANAGED_IDENTITY = flag;
            const result = spawnSync(process.execPath, [
                "--experimental-test-module-mocks", "--no-warnings=ExperimentalWarning",
                "--input-type=module", "-e", script,
            ], { cwd: repoRoot, env, encoding: "utf8" });
            assert.equal(result.status, 0, result.stderr);
            const match = result.stdout.match(/AUTH_OPTIONS:(.*)/);
            assert.ok(match, result.stdout);
            const options = JSON.parse(match[1]);
            assert.equal(options.db, false);
            assert.equal(options.blob, expected);
        });
    }
}
