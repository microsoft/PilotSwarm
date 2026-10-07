import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
    loadWorkerStartupModuleFromEnv,
    WORKER_STARTUP_MODULE_ENV,
} from "../../dist/index.js";

const context = (env = {}) => ({
    env,
    pluginDirs: ["base-plugin"],
    trace() {},
});

test("returns no startup result when the module environment variable is absent", async () => {
    assert.equal(await loadWorkerStartupModuleFromEnv(context()), undefined);
});

test("loads and validates a startup module from a relative path", async () => {
    const headersProvider = async () => ({});
    const shutdown = () => {};
    let importedSpecifier;
    let receivedContext;
    const cwd = path.resolve("worker-root");
    const result = await loadWorkerStartupModuleFromEnv(
        context({
            [WORKER_STARTUP_MODULE_ENV]: "./startup/worker-startup.mjs",
        }),
        {
            cwd,
            importModule: async (specifier) => {
                importedSpecifier = specifier;
                return {
                    initialize(value) {
                        receivedContext = value;
                        return {
                            additionalPluginDirs: [
                                "extra-plugin",
                                "extra-plugin",
                            ],
                            workerOptions: {
                                mcpServers: {
                                    ado: {
                                        type: "http",
                                        url: "https://example.test/mcp",
                                    },
                                },
                                mcpServerHeadersProvider: headersProvider,
                            },
                            shutdown,
                        };
                    },
                };
            },
        },
    );

    assert.equal(
        importedSpecifier,
        pathToFileURL(
            path.resolve(cwd, "startup/worker-startup.mjs"),
        ).href,
    );
    assert.deepEqual(receivedContext.pluginDirs, ["base-plugin"]);
    assert.deepEqual(result.additionalPluginDirs, ["extra-plugin"]);
    assert.equal(
        result.workerOptions.mcpServerHeadersProvider,
        headersProvider,
    );
    assert.equal(result.shutdown, shutdown);
});

test("passes package specifiers through to the module loader", async () => {
    let importedSpecifier;
    await loadWorkerStartupModuleFromEnv(
        context({
            [WORKER_STARTUP_MODULE_ENV]: "@contoso/worker-startup",
        }),
        {
            importModule: async (specifier) => {
                importedSpecifier = specifier;
                return { initialize: () => undefined };
            },
        },
    );
    assert.equal(importedSpecifier, "@contoso/worker-startup");
});

test("fails closed when the configured startup module cannot be imported", async () => {
    const importError = new Error("module missing");
    await assert.rejects(
        loadWorkerStartupModuleFromEnv(
            context({
                [WORKER_STARTUP_MODULE_ENV]: "./missing.mjs",
            }),
            {
                importModule: async () => {
                    throw importError;
                },
            },
        ),
        (error) => {
            assert.match(error.message, /Failed to load worker startup module/);
            assert.equal(error.cause, importError);
            return true;
        },
    );
});

test("requires an initialize export", async () => {
    await assert.rejects(
        loadWorkerStartupModuleFromEnv(
            context({ [WORKER_STARTUP_MODULE_ENV]: "empty-startup" }),
            { importModule: async () => ({}) },
        ),
        /must export an initialize function/,
    );
});

test("rejects unsupported result and worker option fields", async () => {
    await assert.rejects(
        loadWorkerStartupModuleFromEnv(
            context({ [WORKER_STARTUP_MODULE_ENV]: "unsafe-startup" }),
            {
                importModule: async () => ({
                    initialize: () => ({ databaseUrl: "replacement" }),
                }),
            },
        ),
        /unsupported field "databaseUrl"/,
    );
    await assert.rejects(
        loadWorkerStartupModuleFromEnv(
            context({ [WORKER_STARTUP_MODULE_ENV]: "unsafe-options" }),
            {
                importModule: async () => ({
                    initialize: () => ({
                        workerOptions: { store: "replacement" },
                    }),
                }),
            },
        ),
        /cannot override worker option "store"/,
    );
});

test("rejects malformed startup result fields", async () => {
    for (const [result, expected] of [
        [{ additionalPluginDirs: [""] }, /non-empty strings/],
        [{ workerOptions: [] }, /workerOptions must be an object/],
        [{
            workerOptions: { mcpServers: [] },
        }, /mcpServers must be an object/],
        [{
            workerOptions: { mcpServerHeadersProvider: "invalid" },
        }, /mcpServerHeadersProvider must be a function/],
        [{ shutdown: "invalid" }, /shutdown must be a function/],
    ]) {
        await assert.rejects(
            loadWorkerStartupModuleFromEnv(
                context({ [WORKER_STARTUP_MODULE_ENV]: "invalid-startup" }),
                {
                    importModule: async () => ({
                        initialize: () => result,
                    }),
                },
            ),
            expected,
        );
    }
});

test("the standard worker initializes startup additions before construction", async () => {
    const source = await readFile(
        new URL("../../examples/worker.js", import.meta.url),
        "utf8",
    );
    const loadIndex = source.indexOf(
        "await loadWorkerStartupModuleFromEnv",
    );
    const constructionIndex = source.indexOf("new PilotSwarmWorker");

    assert.notEqual(loadIndex, -1);
    assert.notEqual(constructionIndex, -1);
    assert.ok(loadIndex < constructionIndex);
    assert.match(source, /resolveDeploymentMcpWorkerOptions\(\{/);
    assert.match(source, /startupWorkerOptions: workerStartup\?\.workerOptions/);
    assert.match(source, /\.\.\.deploymentMcpWorkerOptions/);
    assert.match(source, /pluginDirs: effectivePluginDirs/);
});

test("the standard worker attempts startup cleanup after draining", async () => {
    const source = await readFile(
        new URL("../../examples/worker.js", import.meta.url),
        "utf8",
    );
    const shutdownIndex = source.indexOf("async function shutdown");
    const drainIndex = source.indexOf(
        "await worker.gracefulShutdown()",
        shutdownIndex,
    );
    const startupShutdownIndex = source.indexOf(
        "await workerStartup?.shutdown?.()",
        shutdownIndex,
    );

    assert.ok(drainIndex > shutdownIndex);
    assert.ok(startupShutdownIndex > drainIndex);
    assert.match(
        source.slice(shutdownIndex),
        /const shutdownErrors = \[\][\s\S]*worker\.gracefulShutdown\(\)[\s\S]*shutdownErrors\.push\(error\)[\s\S]*workerStartup\?\.shutdown\?\.\(\)[\s\S]*shutdownErrors\.push\(error\)[\s\S]*new AggregateError/,
    );
});
